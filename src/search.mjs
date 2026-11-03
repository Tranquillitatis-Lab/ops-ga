import path from 'node:path';
import { mkdir, open, unlink, readFile } from 'node:fs/promises';
import { assert, hash, load, save, random } from './common.mjs';
import { baseline, breed, candidateId, render, select, validateGenome } from './genome.mjs';
import { evaluate, propose } from './runner.mjs';
import { priceUsage, dollarsToMicros, monetaryLimits } from './budget.mjs';
import { trainingFeedback, comparison } from './evidence.mjs';
import { pairedSchedule, pairedStatistics, trialName } from './protocol.mjs';

export class Budget {
  constructor(config, state, persist) { this.config = config; this.limit = config.budget; this.state = state; this.persist = persist; }
  async reserve(episode) {
    const b = this.state.budget;
    assert(!b.pending, 'Interrupted/unknown call: reservation retained; never overwrite pending usage');
    b.accountingUnit = 'session-invocation';
    assert(b.calls + 1 <= this.limit.maxCalls && b.episodes + Number(episode) <= this.limit.maxEpisodes && b.tokens + this.limit.reserveTokensPerCall <= this.limit.maxTokens, 'Budget exhausted; increase limits in a NEW run, or stop');
    const money = monetaryLimits(this.limit);
    const reserved = money.reserve ? dollarsToMicros(money.reserve) : 0;
    assert(!reserved || (b.costMicros ?? 0) + reserved <= dollarsToMicros(money.max), `${money.currency} budget exhausted: no further calls`);
    b.currency = money.currency;
    b.calls++; b.episodes += Number(episode); b.tokens += this.limit.reserveTokensPerCall;
    b.costMicros = (b.costMicros ?? 0) + reserved;
    b.pending = true;
    await this.persist();
  }
  async settle(value) {
    const result = typeof value === 'number' ? { tokens: value } : value;
    const b = this.state.budget;
    assert(b.pending, 'No pending reservation to settle');
    const money = monetaryLimits(this.limit);
    if (result.usageUnknown === true) {
      // Unaccounted invocation: settle it at the reservation it already holds.
      // The conservative amount stays charged (nothing can be under-billed), the
      // gap is written to the ledger, and the campaign continues. The episode is
      // already marked non-selectable, so it cannot win, be compared or exported.
      b.unknownUsageInvocations = (b.unknownUsageInvocations ?? 0) + 1;
      b.unknownUsage ??= [];
      b.unknownUsage.push({ at: new Date().toISOString(), steps: result.usageGaps ?? null, source: result.usageSource ?? null, chargedTokens: this.limit.reserveTokensPerCall, evidence: result.recoveryEvidence ?? null });
      b.lastPricing = { estimatedMicros: null, conservativeMicros: null, method: 'unknown-charged-at-reservation', invoiceVerified: false };
      b.invoiceVerified = false;
      b.pending = false;
      await this.persist();
      assert(b.tokens <= this.limit.maxTokens && (!money.max || b.costMicros <= dollarsToMicros(money.max)), 'Actual usage exceeded reservation: budget overshot; run stopped');
      return;
    }
    const pricing = priceUsage(result, this.config);
    b.tokens += result.tokens - this.limit.reserveTokensPerCall;
    if (money.reserve) b.costMicros += pricing.estimatedMicros - dollarsToMicros(money.reserve);
    b.estimatedSpentMicros = (b.estimatedSpentMicros ?? 0) + pricing.estimatedMicros;
    b.conservativeSpentMicros = (b.conservativeSpentMicros ?? 0) + pricing.conservativeMicros;
    b.modelSteps = (b.modelSteps ?? 0) + (result.steps ?? 0);
    b.unknownStepInvocations = (b.unknownStepInvocations ?? 0) + Number(result.steps === undefined);
    b.lastPricing = pricing;
    b.invoiceVerified = false;
    b.pending = false;
    await this.persist();
    assert(b.tokens <= this.limit.maxTokens && (!money.max || b.costMicros <= dollarsToMicros(money.max)), 'Actual usage exceeded reservation: budget overshot; run stopped');
  }
}
export async function withState(config, lane, fn) {
  const root = path.resolve(path.join(config.output, lane.id));
  await mkdir(root, { recursive: true });
  // One global ledger/lock: all optimization lanes share the user's total budget.
  const lockPath = path.join(config.output, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); } catch (e) { if (e.code === 'EEXIST') throw new Error(`Run locked: ${lockPath}; verify no live owner before manual recovery`); throw e; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const file = path.join(root, 'state.json');
    let state;
    try { state = await load(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!state) state = { version: 1, fingerprint: config.fingerprint, generation: 0, candidates: {}, evaluations: {}, plans: {}, history: [], budget: { calls: 0, episodes: 0, tokens: 0, pending: false }, synthetic: config.runner.type === 'mock' };
    assert(state.fingerprint === config.fingerprint, 'Configuration changed: choose a new output directory (cached results are fingerprint-bound)');
    const ledgerFile = path.join(config.output, 'budget.json');
    let ledger;
    try { ledger = await load(ledgerFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (!ledger) ledger = { fingerprint: config.fingerprint, budget: state.budget };
    assert(ledger.fingerprint === config.fingerprint, 'Configuration changed: global budget fingerprint differs');
    state.budget = ledger.budget;
    assert(!state.budget.pending, 'Interrupted/unknown call: reservation retained. Inspect private evidence and budget before manual recovery; never auto-retry a possibly billed call');
    const persist = async () => { await save(ledgerFile, ledger); await save(file, state); };
    await persist();
    return await fn({ state, root, persist, budget: new Budget(config, state, persist) });
  } finally { await lock.close(); await unlink(lockPath); }
}
async function score(config, lane, genome, split, ctx, only = null) {
  const { state, root, persist, budget } = ctx;
  const id = candidateId(lane, genome);
  state.candidates[id] = genome;
  const results = [];
  const repetitions = config.evaluation?.repetitions ?? 1;
  for (const task of config.tasks.filter(t => t.split === split)) for (let repetition = 0; repetition < repetitions; repetition++) {
    if (only && (task.id !== only.task || repetition !== only.repetition)) continue;
    const trial = trialName(task, repetition, repetitions);
    const key = `${id}/${split}/${trial}`;
    if (!state.evaluations[key]) {
      await budget.reserve(true);
      // Each trial is in its own workspace; saved results only reused within exact config fingerprint.
      const result = await evaluate(config, lane, genome, { ...task, repetition, trialId: trial, baselineWithoutGuidance: id === candidateId(lane, baseline(lane)) }, path.join(root, 'episodes', id, split, trial));
      if (result.synthetic === false && result.sessionId) assert(!Object.values(state.evaluations).some(r => r.sessionId === result.sessionId), 'DSH session identity reused across isolated trials');
      result.task = trial; result.taskId = task.id; result.repetition = repetition;
      result.executionIndex = state.nextExecutionIndex ?? 0; state.nextExecutionIndex = result.executionIndex + 1;
      result.evaluationId = key;
      state.evaluations[key] = result;
      await budget.settle(result);
      await persist();
    }
    const result = state.evaluations[key];
    // A grading-infrastructure failure stops the campaign because every later episode
    // would be paid against a broken grader. An unaccounted invocation only disqualifies
    // that episode, so it must not abort the run.
    assert(result.selectionEligible !== false || result.usageUnknown === true, `${split === 'test' ? 'Final grading incomplete' : id === candidateId(lane, baseline(lane)) ? 'Baseline grading infrastructure failed' : 'Candidate grading infrastructure failed'}; inference usage settled. Inspect receipts and regrade without new inference`);
    results.push(result);
  }
  return { id, genome, results, successes: results.filter(r => r.success).length, tokens: results.reduce((s, r) => s + r.tokens, 0) };
}
export async function runSearch(config, lane) {
  return withState(config, lane, async ctx => {
    const { state, root, persist, budget } = ctx;
    assert(!state.finalStarted, 'Final holdout was already opened. Start a new run with a NEW held-out task suite');
    const initial = baseline(lane);
    const reference = await score(config, lane, initial, 'train', ctx);
    const gateReference = await score(config, lane, initial, 'gate', ctx);
    for (let generation = state.generation; generation < config.search.generations; generation++) {
      const rng = random(config.seed + generation);
      const previous = state.history.at(-1)?.elites ?? [reference.id];
      const parents = previous.map(id => state.candidates[id]);
      const plan = state.plans[generation] ?? [initial, ...parents, ...(lane.seeds ?? [])].filter((g, i, a) => a.findIndex(x => hash(x) === hash(g)) === i).slice(0, config.search.population);
      state.plans[generation] = plan;
      let attempts = 0;
      while (lane.kind !== 'source' && plan.length < config.search.population && attempts++ < config.search.population * 6) {
        let genome = breed(lane, parents[Math.floor(rng() * parents.length)], parents[Math.floor(rng() * parents.length)], rng);
        if (config.runner.type !== 'mock' && config.search.llmMutation !== false) {
          await budget.reserve(false);
          const reply = await propose(config, lane, parents, trainingFeedback(state, reference.id), path.join(root, 'proposals', `${generation}-${state.budget.calls}`));
          await budget.settle(reply);
          try { genome = validateGenome(lane, JSON.parse(reply.text)); }
          catch (error) { state.rejections ??= []; state.rejections.push({ generation, reason: error.message }); await persist(); continue; }
        }
        if (!plan.some(g => hash(g) === hash(genome))) { plan.push(genome); await persist(); }
      }
      const training = [];
      for (const genome of plan) training.push(await score(config, lane, genome, 'train', ctx));
      const shortlisted = select(training, reference, config.maxRegressions ?? 0).slice(0, config.search.elites);
      const gated = [];
      for (const row of shortlisted) gated.push(await score(config, lane, row.genome, 'gate', ctx));
      const qualified = select(gated, gateReference, config.maxRegressions ?? 0);
      const elites = qualified.length ? qualified.map(r => r.id) : [reference.id];
      state.history.push({ generation, elites, training: training.map(({ id, tokens, successes }) => ({ id, tokens, successes })), gate: gated.map(({ id, tokens, successes }) => ({ id, tokens, successes })) });
      state.winner = elites[0]; state.generation = generation + 1;
      await persist();
    }
    await save(path.join(root, 'candidate.json'), { lane: lane.id, genome: state.candidates[state.winner], fingerprint: config.fingerprint, synthetic: state.synthetic, status: 'selected-on-tuning-gate-not-final-validated' });
    return { lane: lane.id, winner: state.winner, generations: state.generation, budget: state.budget, synthetic: state.synthetic, artifact: path.join(root, 'candidate.json') };
  });
}
export async function validateFinal(config, lane) {
  return withState(config, lane, async ctx => {
    const { state, persist } = ctx;
    assert(state.winner && state.generation === config.search.generations, 'Search must finish before final evaluation');
    if (state.final) return state.final;
    state.finalStarted = true;
    await persist();
    const baseGenome = baseline(lane), baseId = candidateId(lane, baseGenome);
    state.finalSchedule ??= pairedSchedule(config, lane, baseId, state.winner);
    await persist();
    for (const pair of state.finalSchedule) for (const arm of pair.order) {
      await score(config, lane, arm === 'baseline' ? baseGenome : state.candidates[state.winner], 'test', ctx, pair);
    }
    const reference = await score(config, lane, baseGenome, 'test', ctx);
    const candidate = await score(config, lane, state.candidates[state.winner], 'test', ctx);
    const paired = comparison(reference, candidate);
    paired.comparisonKind = baseId === state.winner ? 'identity-control' : 'repeated-task-paired';
    paired.protocol = { ...config.evaluation, schedule: state.finalSchedule, taskManifestHash: config.taskManifestHash, actualExecution: [...new Set([...reference.results, ...candidate.results].map(r => r.evaluationId))].map(id => ({ evaluationId: id, executionIndex: state.evaluations[id].executionIndex })).sort((a, b) => a.executionIndex - b.executionIndex) };
    paired.statistics = pairedStatistics(paired.pairs, config.seed);
    const regressions = candidate.results.filter((r, i) => reference.results[i].success && !r.success).map(r => r.task);
    // Any unaccounted arm makes the paired claim unsupportable: report it and refuse the
    // export instead of publishing a comparison built on unknown spend.
    const unaccounted = [...reference.results, ...candidate.results].filter(r => r.usageUnknown === true).map(r => r.task);
    state.final = { ...paired, status: regressions.length || unaccounted.length || !candidate.results.every(r => r.safety) ? 'rejected' : 'no-observed-regression', regressions, unaccounted, baselineTokens: reference.tokens, candidateTokens: candidate.tokens, savings: 1 - candidate.tokens / reference.tokens, baselineSuccesses: reference.successes, candidateSuccesses: candidate.successes, tasks: paired.statistics.tasks, pairedObservations: reference.results.length, synthetic: state.synthetic, statisticalNonInferiorityProven: false };
    await persist(); return state.final;
  });
}
export async function exportWinner(config, lane, destination) {
  return withState(config, lane, async ({ state }) => {
    assert(state.final?.status === 'no-observed-regression' && !state.synthetic && Object.values(state.evaluations).every(r => r.synthetic === false), 'Export requires a real completed final evaluation without observed regressions');
    assert(state.final.baselineSuccesses > 0 && state.final.candidateSuccesses >= state.final.baselineSuccesses, 'Cannot export an all-failed or quality-degraded final suite');
    assert(state.final.candidateTokens < state.final.baselineTokens, 'No measured token improvement');
    await save(destination, { version: 1, lane: lane.id, kind: lane.kind ?? 'guidance', fingerprint: config.fingerprint, guidance: lane.kind === 'source' ? undefined : render(lane, state.candidates[state.winner]), sourcePayload: lane.kind === 'source' ? { bindings: lane.bindings, adapter: config.runner.module, taskManifestHash: config.taskManifestHash, manualReviewRequired: true } : undefined, genome: state.candidates[state.winner], evidence: state.final, productionModelCallsAdded: 0 });
    return { destination, note: 'Review and integrate manually; no OPS source or profile was changed' };
  });
}
