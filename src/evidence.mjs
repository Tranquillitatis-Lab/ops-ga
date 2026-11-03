import path from 'node:path';
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { hash, load, save, assert, safeFile } from './common.mjs';
import { parseHeadless } from './runner.mjs';
import { priceUsage, validatePricing } from './budget.mjs';

// Only train evidence is ever fed back into the optimizer. No gate/test payloads.
export function trainingFeedback(state, baselineId, limit = 12) {
  const rows = [];
  for (const [key, result] of Object.entries(state.evaluations)) {
    const [id, split, task] = key.split('/');
    if (split !== 'train') continue;
    const base = state.evaluations[`${baselineId}/train/${task}`];
    if (!base) continue;
    rows.push({ candidateId: id, task, success: result.success, baselineSuccess: base.success, safety: result.safety,
      tokens: result.tokens, baselineTokens: base.tokens, tokenDelta: result.tokens - base.tokens,
      modelSteps: result.steps ?? null, toolCounts: result.toolCounts ?? null });
  }
  rows.sort((a, b) => Number(b.baselineSuccess && !b.success) - Number(a.baselineSuccess && !a.success) || Math.abs(b.tokenDelta) - Math.abs(a.tokenDelta) || a.candidateId.localeCompare(b.candidateId) || a.task.localeCompare(b.task));
  return { version: 1, scope: 'train-only', observations: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit), generations: state.history.slice(-3).map(h => ({ generation: h.generation, training: h.training })), rejections: (state.rejections ?? []).slice(-5).map(r => ({ reason: r.reason })) };
}
export function comparison(reference, candidate) {
  const baselineSelected = reference.id === candidate.id;
  return { comparisonKind: baselineSelected ? 'identity-control' : 'paired-task-single-observation', baselineSelected, independentArms: !baselineSelected,
    pairs: reference.results.map(base => {
      const other = candidate.results.find(r => r.task === base.task);
      assert(other, 'Missing candidate task in pair');
      return { task: base.taskId ?? base.task, trialId: base.task, repetition: base.repetition ?? 0, baselineEvaluationId: base.evaluationId ?? `${reference.id}/test/${base.task}`, candidateEvaluationId: other.evaluationId ?? `${candidate.id}/test/${base.task}`, reusedEvaluation: baselineSelected,
        baselineTokens: base.tokens, candidateTokens: other.tokens, tokenDelta: other.tokens - base.tokens, baselineSuccess: base.success, candidateSuccess: other.success };
    }), limitations: ['sampling-uncontrolled', 'cache-uncontrolled', ...(baselineSelected ? ['same-evaluation-not-an-independent-ab-test'] : [])] };
}

async function checkAnalysisDestination(root, out) {
  const physicalRoot = await realpath(root);
  let ancestor = path.dirname(out);
  // Reject directory links (including Windows junctions), even when their textual
  // location is outside the run. Do not allow output to mutate source evidence.
  while (true) {
    try { assert(!(await lstat(ancestor)).isSymbolicLink(), 'Analysis output has a linked ancestor'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  let existing = path.dirname(out), physicalAncestor;
  while (true) {
    try { physicalAncestor = await realpath(existing); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; existing = path.dirname(existing); }
  }
  const relative = path.relative(physicalRoot, path.resolve(physicalAncestor, path.relative(existing, out)));
  assert(relative !== '' && (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)), 'Analysis output must be physically outside the source run directory');
}
// Discover only the known lane/episodes/candidate/split/task layout. Do not sweep
// arbitrary private homes or follow links while looking for unscored attempts.
async function unscoredAttempts(root, lane, evaluations) {
  const attempts = [];
  const pending = [{ relative: `${lane}/episodes`, depth: 0 }];
  while (pending.length) {
    const { relative, depth } = pending.pop();
    let entries;
    try { entries = await readdir(await safeFile(root, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (depth < 3) {
      for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) if (entry.isDirectory()) pending.push({ relative: `${relative}/${entry.name}`, depth: depth + 1 });
      continue;
    }
    const [, , candidateId, split, task] = relative.split('/');
    if (evaluations[`${candidateId}/${split}/${task}`]) continue;
    const attemptFile = `${relative}/attempt.json`;
    let receipt = null;
    if (entries.some(e => e.name === 'attempt.json' && e.isFile())) receipt = await load(await safeFile(root, attemptFile));
    attempts.push({ episodeId: `${lane}/${candidateId}/${split}/${task}`, status: receipt?.status ?? 'unscored', failureCode: receipt?.failureCode ?? null,
      billing: receipt?.billing ?? 'unknown', tokens: null, source: receipt ? { path: attemptFile } : null, evidenceStatus: 'unscored-attempt' });
  }
  return attempts;
}

// A private, deterministic projection. Never copies answers, tool inputs/results, or prompts.
// Historical outputs are inspected without changing their fingerprint, ledger or state.
export async function analyzeRun(runDirectory, destination, pricing = null) {
  if (pricing) validatePricing(pricing);
  const pricingConfig = pricing ? { runner: { type: 'dsh' }, budget: pricing } : null;
  const root = path.resolve(runDirectory), out = path.resolve(destination);
  assert(out !== root && !root.startsWith(out + path.sep) && !out.startsWith(root + path.sep), 'Analysis output must be outside the source run directory');
  await checkAnalysisDestination(root, out);
  const episodes = [], proposals = [], pairs = [], issues = [], attempts = [];
  const states = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const laneRoot = await safeFile(root, `${entry.name}/state.json`);
    let bytes;
    try { bytes = await readFile(laneRoot, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const state = JSON.parse(bytes), lane = entry.name;
    states.push({ lane, stateDigest: hash(bytes), fingerprint: state.fingerprint });
    for (const [key, result] of Object.entries(state.evaluations ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const [candidateId, split, task, extra] = key.split('/');
      assert(!extra && candidateId && ['train', 'gate', 'test'].includes(split) && task, 'Invalid evaluation key');
      const episodeId = `${lane}/${key}`;
      const relative = `${lane}/episodes/${candidateId}/${split}/${task}/session.private.jsonl`;
      let facts = null, sourceDigest = null;
      if (state.synthetic !== true) {
        try { const text = await readFile(await safeFile(root, relative), 'utf8'); sourceDigest = hash(text); facts = parseHeadless(text); }
        catch (e) { issues.push({ episodeId, code: e.code === 'ENOENT' ? 'session.missing' : 'session.invalid', selectionEligible: false }); }
      }
      const mismatch = facts && facts.tokens !== result.tokens;
      if (facts && facts.usageComplete === false) {
        // The headless projection dropped some step usage. Separate an episode whose
        // total was reconciled from DSH's archive from one that genuinely has no number.
        issues.push({ episodeId, code: result.usageUnknown ? 'usage.unaccounted' : 'usage.reconciled_from_session_log', gaps: facts.usageGaps, selectionEligible: result.usageUnknown ? false : true });
      } else if (mismatch) issues.push({ episodeId, code: 'usage.state_mismatch', selectionEligible: false });
      episodes.push({ schemaVersion: 'ops-ga.episode-summary/1', episodeId, lane, candidateId, optimizationSplit: split, task,
        tokens: result.tokens, usage: facts?.usage ?? result.usage ?? null, success: result.success, safety: result.safety,
        gradingOutcome: result.gradingOutcome ?? null, selectionEligible: result.selectionEligible ?? true, agentCompleted: result.agentCompleted ?? null,
        safetyScope: result.safetyScope ?? 'legacy-or-adapter-claim-not-verified', synthetic: result.synthetic,
        taskId: result.taskId ?? task, repetition: result.repetition ?? 0, exposure: result.exposure ?? null,
        sourceCandidate: result.source ? { payloadDigest: result.source.payloadDigest, sourceDigest: result.source.sourceDigest, repositoryRevision: result.source.repositoryRevision, compiledModules: result.source.compiledModules } : null,
        modelSteps: facts?.steps ?? result.steps ?? null, termination: facts?.termination ?? result.termination ?? 'unavailable',
        toolCounts: facts?.toolCounts ?? result.toolCounts ?? null, toolStatuses: facts?.toolStatuses ?? result.toolStatuses ?? null,
        source: sourceDigest ? { path: relative, sha256: sourceDigest, structure: facts?.structure ?? null } : null,
        timeline: facts?.timeline ?? null,
        cost: pricingConfig && facts ? priceUsage(facts, pricingConfig) : null,
        evidenceStatus: state.synthetic ? 'synthetic' : !facts || mismatch ? 'incomplete' : 'usage-reconciled-not-runtime-attested' });
    }
    let proposalNames = [];
    try { proposalNames = await readdir(path.join(root, lane, 'proposals')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const name of proposalNames.sort()) {
      try {
        const relative = `${lane}/proposals/${name}/session.private.jsonl`, text = await readFile(await safeFile(root, relative), 'utf8'), facts = parseHeadless(text);
        proposals.push({ lane, proposalId: `${lane}/${name}`, tokens: facts.tokens, usage: facts.usage, modelSteps: facts.steps, toolCounts: facts.toolCounts, cost: pricingConfig ? priceUsage(facts, pricingConfig) : null, source: { path: relative, sha256: hash(text) }, timeline: facts.timeline });
      } catch { issues.push({ lane, proposalId: `${lane}/${name}`, code: 'proposal.capture_missing_or_invalid' }); }
    }
    attempts.push(...await unscoredAttempts(root, lane, state.evaluations ?? {}));
    for (const pair of state.final?.pairs ?? []) pairs.push({ lane, ...pair });
    if (state.final && !state.final.pairs) {
      // Legacy state has no declared baseline identity; never guess from equal tokens alone.
      pairs.push({ lane, comparisonKind: 'legacy-pairing-unavailable', baselineTokens: state.final.baselineTokens, candidateTokens: state.final.candidateTokens, reuse: 'unknown' });
    }
    assert(hash(await readFile(laneRoot, 'utf8')) === hash(bytes), 'Run changed during analysis; retry after it stops');
  }
  assert(states.length > 0, 'No lane state files found');
  let ledger = null;
  try { const saved = await load(path.join(root, 'budget.json')); const b = saved.budget; ledger = { currency: b.currency, tokens: b.tokens, sessionInvocations: b.calls, modelSteps: b.modelSteps ?? null, pending: b.pending, occupiedMicros: b.costMicros ?? null, estimatedSpentMicros: b.estimatedSpentMicros ?? null, conservativeSpentMicros: b.conservativeSpentMicros ?? null, invoiceVerified: false }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (ledger?.pending) issues.push({ code: 'billing.pending_reservation', usageComplete: false, automaticRetryAllowed: false });
  for (const attempt of attempts) issues.push({ episodeId: attempt.episodeId, code: 'evaluation.unscored_attempt', selectionEligible: false });
  if (ledger && ledger.sessionInvocations !== episodes.length + proposals.length) issues.push({ code: 'accounting.invocation_count_mismatch', ledgerInvocations: ledger.sessionInvocations, indexedInvocations: episodes.length + proposals.length, usageComplete: false });
  const repricing = pricing ? { currency: pricing.currency, rates: pricing.rates, pricedInvocations: [...episodes, ...proposals].filter(e => e.cost).length, estimatedMicros: [...episodes, ...proposals].reduce((s, e) => s + (e.cost?.estimatedMicros ?? 0), 0), conservativeMicros: [...episodes, ...proposals].reduce((s, e) => s + (e.cost?.conservativeMicros ?? 0), 0), invoiceVerified: false, updatesLedger: false } : null;
  const index = { schemaVersion: 'ops-ga.analysis/1', visibility: 'private-unreviewed', sourceStates: states, ledger, repricing, episodes, proposals, attempts, pairs, issues,
    limitations: ['facts-not-architecture-causation', 'source-text-is-untrusted-data', 'no-per-tool-token-attribution', 'not-a-public-submission', 'missing-facts-remain-null'],
    totals: { evaluatedEpisodes: episodes.length, proposalInvocations: proposals.length, observedModelSteps: [...episodes, ...proposals].reduce((s, e) => s + (e.modelSteps ?? 0), 0), tokenTotal: [...episodes, ...proposals].reduce((s, e) => s + e.tokens, 0) } };
  await checkAnalysisDestination(root, out);
  await save(out, index);
  return { destination: out, ...index.totals, issues: issues.length, repricing, visibility: index.visibility };
}
