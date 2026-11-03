import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { assert, integer, safeFile, save, hash } from './common.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyExposure } from './exposure.mjs';
import { execute } from './process.mjs';
import { render } from './genome.mjs';
import { adapterCall } from './adapter.mjs';
import { recoverSessionUsage } from './session-usage.mjs';

export function dshLaunch(runner) {
  if (process.platform === 'win32' && /\.cmd$/i.test(runner.command)) return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('../bin/launch-dsh.ps1', import.meta.url)), '-DshBin', runner.command, ...runner.args] };
  return { command: runner.command, args: runner.args };
}
// Live guard for ONE paid invocation. It answers a single question: has this
// invocation already outspent the reservation taken for it? A missing or
// malformed usage event is a missing measurement, not evidence of runaway
// spending, so it is recorded as a gap and reconciled after the process ends.
// The remaining bound for a gapped invocation is the wall-clock timeout plus the
// full reservation charged at settlement.
export function usageGuard(config) {
  let pending = '', tokens = 0;
  const gaps = [];
  const guard = chunk => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type !== 'status' || event.phase !== 'step_end') continue;
      const u = event.usage;
      const value = u && typeof u === 'object' && ['inputTokens', 'outputTokens'].every(key => Number.isSafeInteger(u[key]) && u[key] >= 0) &&
        ['cacheReadTokens', 'cacheWriteTokens'].every(key => u[key] === undefined || (Number.isSafeInteger(u[key]) && u[key] >= 0))
        ? u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0) : null;
      if (value === null) { gaps.push({ turn: event.turn, step: event.step }); continue; }
      tokens += value;
      assert(tokens < config.budget.reserveTokensPerCall, 'Call token reservation reached; stopping owned process. Reservation remains charged.');
    }
  };
  // Exposed so a caller can log how many steps the projection failed to bill.
  guard.usageGaps = gaps;
  return guard;
}
export function parseHeadless(text) {
  const sourceLines = text.split(/\r?\n/).map((line, index) => ({ line, sourceLine: index + 1 })).filter(e => e.line.trim());
  const events = sourceLines.map(e => JSON.parse(e.line));
  assert(events[0]?.type === 'session' && typeof events[0].sessionId === 'string' && events[0].sessionId, 'Missing DSH session event or identity');
  assert(events.filter(e => e.type === 'session').length === 1 && events.filter(e => e.type === 'final').length === 1, 'Multiple session/final boundaries');
  assert(events.at(-1)?.type === 'final' && typeof events.at(-1).text === 'string', 'Missing DSH final event');
  const steps = events.filter(e => e.type === 'status' && e.phase === 'step_end');
  assert(steps.length > 0, 'No model steps');
  let tokens = 0;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
  // Steps whose usage the projection omitted. They are counted as gaps instead of
  // aborting the parse; reconcileUsage() then tries to recover them from DSH's
  // own archive and marks the episode unknown when it cannot.
  const usageGaps = [];
  for (const step of steps) {
    const u = step.usage;
    if (!u || step.truncated) { usageGaps.push({ turn: step.turn, step: step.step }); continue; }
    for (const key of ['inputTokens', 'outputTokens']) integer(u[key], 0, Number.MAX_SAFE_INTEGER, key);
    for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens']) if (u[key] !== undefined) integer(u[key], 0, Number.MAX_SAFE_INTEGER, key);
    // DSH normalized counters: inputTokens excludes cached input; reasoning is within output.
    const sum = u.inputTokens + u.outputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
    assert(u.totalTokens === undefined || u.totalTokens === sum, 'Inconsistent DSH totalTokens');
    assert(u.reasoningTokens === undefined || u.reasoningTokens <= u.outputTokens, 'Reasoning must be a subset of output');
    tokens += sum;
    integer(tokens, 0, Number.MAX_SAFE_INTEGER, 'aggregate tokens');
    for (const key of Object.keys(usage)) usage[key] += u[key] ?? 0;
  }
  const started = events.filter(e => e.type === 'status' && e.phase === 'step_start');
  const identified = [...started, ...steps].some(e => e.turn !== undefined || e.step !== undefined);
  if (identified) {
    const active = new Set(), ended = new Set();
    for (const event of events.filter(e => e.type === 'status' && ['step_start', 'step_end'].includes(e.phase))) {
      integer(event.turn, 1, Number.MAX_SAFE_INTEGER, 'turn'); integer(event.step, 1, Number.MAX_SAFE_INTEGER, 'step');
      const key = `${event.turn}/${event.step}`;
      if (event.phase === 'step_start') { assert(!active.has(key) && !ended.has(key), 'Duplicate model step start'); active.add(key); }
      else { assert(active.delete(key) && !ended.has(key), 'Duplicate/orphan model step end'); ended.add(key); }
    }
    assert(active.size === 0, 'Unclosed model step: usage may be incomplete');
  } else assert(started.length === 0, 'Model steps lack identities');
  const ends = events.filter(e => e.type === 'status' && e.phase === 'turn_end');
  assert(ends.length > 0, 'Missing turn outcome');
  const toolCounts = {}, toolStatuses = {};
  for (const event of events) {
    if (event.type === 'tool_call' && typeof event.tool === 'string') toolCounts[event.tool] = (toolCounts[event.tool] ?? 0) + 1;
    if (event.type === 'tool_result' && typeof event.status === 'string') toolStatuses[event.status] = (toolStatuses[event.status] ?? 0) + 1;
  }
  const timeline = events.map((event, index) => ({ sourceLine: sourceLines[index].sourceLine, type: event.type, phase: event.phase,
    ...(event.type === 'status' && event.phase === 'step_end' ? { turn: event.turn, step: event.step, usage: event.usage ? Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'].filter(k => event.usage[k] !== undefined).map(k => [k, event.usage[k]])) : null } : {}),
    ...(event.type === 'tool_call' ? { callId: event.callId, tool: event.tool, inputBytes: Buffer.byteLength(JSON.stringify(event.input ?? null)) } : {}),
    ...(event.type === 'tool_result' ? { callId: event.callId, status: event.status, resultBytes: Buffer.byteLength(JSON.stringify(event.result ?? null)) } : {}) }));
  return { answer: events.at(-1).text, tokens, usage, timeline, completed: ends.at(-1).reason?.kind === 'completed', termination: ends.at(-1).reason?.kind ?? 'unknown', sessionId: events[0].sessionId, steps: steps.length, usageGaps, usageComplete: usageGaps.length === 0, structure: identified ? 'identified-steps' : 'legacy-unidentified', toolCounts, toolStatuses };
}

// Reconcile one parsed invocation against DSH's private archive when the headless
// projection dropped usage for some steps. Recovery is all-or-nothing: a partial
// answer would under-charge the ledger, so anything short of every gap is treated
// as unknown and the episode becomes non-selectable instead of guessed.
export async function reconcileUsage(config, dir, result) {
  if (result.usageComplete) return { ...result, usageSource: 'headless-step_end' };
  const recovered = config.runner.type === 'dsh'
    ? await recoverSessionUsage({ home: config.runner.home, sessionId: result.sessionId, gaps: result.usageGaps })
    : null;
  const complete = recovered?.complete === true;
  // Audit trail stays next to the episode so a human can re-derive the number.
  await save(path.join(dir, 'usage.recovery.json'), {
    version: 1, sessionId: result.sessionId ?? null, gaps: result.usageGaps,
    recovered: recovered ? { source: recovered.source, file: recovered.file, recoveredSteps: recovered.recoveredSteps, missingSteps: recovered.missingSteps, usage: recovered.usage } : null,
    resolution: complete ? 'recovered' : 'unknown'
  });
  if (!complete) return { ...result, usageUnknown: true, usageSource: 'unrecovered', recoveryEvidence: 'usage.recovery.json' };
  const lifted = recovered.usage;
  const liftedTokens = lifted.inputTokens + lifted.outputTokens + lifted.cacheReadTokens + lifted.cacheWriteTokens;
  return {
    ...result,
    tokens: result.tokens + liftedTokens,
    usage: Object.fromEntries(Object.keys(result.usage).map(key => [key, result.usage[key] + (lifted[key] ?? 0)])),
    usageComplete: true, usageSource: 'dsh-session-archive', recoveryEvidence: 'usage.recovery.json'
  };
}

export function runtimePatch(runner) {
  return [
    { id: 'agent-default-model', config: { provider: runner.provider, model: runner.model, ...(runner.reasoningEffort ? { reasoningEffort: runner.reasoningEffort } : {}) } },
    ...(runner.maxOutputTokens ? [{ id: 'llm-deepseek', config: { maxTokens: runner.maxOutputTokens } }] : []),
    { id: 'sandbox-policy', config: { mode: runner.permission } },
    // Root-only CLI usage does not account for child/summary models. Disable them, not merely ask the agent.
    ...['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'compaction-basic', 'tool-plugin-manager', 'tool-goal', 'workflow-ptc', 'tool-workflow'].map(id => ({ id, disabled: true }))
  ];
}
export async function captureExecution(dir, command, args, options) {
  await mkdir(dir, { recursive: true });
  try {
    const result = await execute(command, args, options);
    await writeFile(path.join(dir, 'session.private.jsonl'), result.stdout, { mode: 0o600 });
    await writeFile(path.join(dir, 'stderr.private.txt'), result.stderr, { mode: 0o600 });
    await save(path.join(dir, 'attempt.json'), { version: 1, status: 'captured', code: result.code, signal: result.signal, elapsedMs: result.elapsedMs, captureComplete: result.captureComplete, capturedBytes: result.capturedBytes });
    return result;
  } catch (error) {
    await writeFile(path.join(dir, 'session.private.jsonl'), error.stdout ?? '', { mode: 0o600 });
    await writeFile(path.join(dir, 'stderr.private.txt'), error.stderr ?? '', { mode: 0o600 });
    await save(path.join(dir, 'attempt.json'), { version: 1, status: 'failed', failureCode: error.failureCode ?? 'process.unknown', code: error.code ?? null, signal: error.signal ?? null, elapsedMs: error.elapsedMs ?? null, captureComplete: error.captureComplete ?? false, capturedBytes: error.capturedBytes ?? 0, billing: 'reserved_unknown' });
    throw error;
  }
}
export async function prepareTask(dir, task) {
  await mkdir(dir, { recursive: true });
  const workspace = path.join(dir, 'workspace');
  // Never evaluate in an old trial workspace, even if a previous process left artifacts.
  await mkdir(workspace, { recursive: false });
  for (const [name, content] of Object.entries(task.files)) {
    const file = await safeFile(workspace, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, { mode: 0o600 });
  }
  return workspace;
}
export async function verify(task, workspace, answer) {
  if (task.check.type === 'answer-includes') return answer.includes(task.check.value);
  try {
    if (task.check.type === 'files-equal') {
      for (const [name, value] of Object.entries(task.check.values)) if (await readFile(await safeFile(workspace, name), 'utf8') !== value) return false;
      return true;
    }
    return await readFile(await safeFile(workspace, task.check.path), 'utf8') === task.check.value;
  }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export async function evaluate(config, lane, genome, task, dir) {
  const workspace = await prepareTask(dir, task);
  return evaluateWorkspace(config, lane, genome, task, dir, workspace);
}
export async function evaluateWorkspace(config, lane, genome, task, dir, workspace) {
  if (config.runner.type === 'mock') {
    // Deliberately synthetic: no result is evidence of real OPS quality or efficiency.
    const tokens = 1000 + render(lane, genome).length * 3 + parseInt(hash({ genome, task: task.id }).slice(0, 4), 16) % 200;
    return { task: task.id, success: true, safety: true, tokens, synthetic: true };
  }
  if (config.runner.type === 'adapter') {
    const result = await adapterCall(config, 'evaluate', { lane, genome, task, workspace }, dir);
    integer(result.tokens, 1, Number.MAX_SAFE_INTEGER, 'adapter tokens');
    assert(typeof result.success === 'boolean' && typeof result.safety === 'boolean' && typeof result.synthetic === 'boolean', 'Adapter requires success, safety, synthetic');
    return { ...result, task: task.id };
  }
  const patchFile = path.join(dir, 'runtime.patch.json');
  const exposureFile = path.join(dir, 'exposure.private.jsonl');
  const patch = [...runtimePatch(config.runner), ...(config.runner.exposure ? [{ insert: [{ id: 'ops-ga-exposure-observer', name: pathToFileURL(fileURLToPath(new URL('./exposure-observer.mjs', import.meta.url))).href, config: { output: exposureFile, payloadDigest: config.runner.payloadDigest ?? config.fingerprint, expected: { ...config.runner.exposure, provider: config.runner.provider, model: config.runner.model, permission: config.runner.permission } } }] }] : [])];
  await save(patchFile, patch);
  const launcher = dshLaunch(config.runner);
  const args = [...launcher.args, '--profile', config.runner.profile, ...(config.runner.sourcePatch ? ['--patch', config.runner.sourcePatch] : []), '--patch', patchFile, '--json'];
  const prompt = `Offline OPS benchmark. Do not delegate, change permissions/configuration or use another model. Work only in this fixture.\n\n${task.baselineWithoutGuidance ? '' : render(lane, genome)}\n\nTask:\n${task.prompt}`;
  const guard = usageGuard(config);
  const { stdout, code } = await captureExecution(dir, launcher.command, args, { cwd: workspace, env: { DSH_HOME: config.runner.home, DSH_PERMISSION_MODE: config.runner.permission }, input: prompt, timeoutMs: config.runner.timeoutMs, onStdout: guard, allowNonZero: true });
  const result = await reconcileUsage(config, dir, parseHeadless(stdout));
  // Persist counts and identity, not raw conversations containing private data.
  await save(path.join(dir, 'receipt.json'), { ...result, answer: undefined, answerHash: hash(result.answer) });
  const exposure = config.runner.exposure ? await verifyExposure(exposureFile, { ...config.runner.exposure, provider: config.runner.provider, model: config.runner.model, permission: config.runner.permission }, result, config.runner.payloadDigest ?? config.fingerprint) : null;
  const success = code === 0 && result.completed && await verify(task, workspace, result.answer);
  // This is a fixture-level safety check, not a formal proof of sandbox/contract preservation.
  return { task: task.id, success, safety: true, exposure, safetyScope: exposure ? 'wire-surface-route-policy-verified-not-os-sandbox-proof' : 'local-runtime-guards-not-contract-proof', tokens: result.tokens, usage: result.usage, steps: result.steps, toolCounts: result.toolCounts, toolStatuses: result.toolStatuses, termination: result.termination, structure: result.structure, sessionId: result.sessionId, synthetic: false, usageSource: result.usageSource, ...(result.usageUnknown ? { usageUnknown: true, selectionEligible: false, usageGaps: result.usageGaps, recoveryEvidence: result.recoveryEvidence } : {}) };
}

export async function propose(config, lane, parents, feedback, dir) {
  if (config.runner.type === 'adapter') {
    const result = await adapterCall(config, 'propose', { lane, parents, feedback }, dir);
    integer(result.tokens, 1, Number.MAX_SAFE_INTEGER, 'adapter proposal tokens');
    assert(typeof result.text === 'string', 'Adapter proposal must return text');
    return result;
  }
  const patchFile = path.join(dir, 'runtime.patch.json');
  await mkdir(dir, { recursive: true });
  await save(patchFile, [...runtimePatch({ ...config.runner, permission: 'read-only' }), ...['tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-web', 'tool-skill', 'dsh-ops', 'ops-file', 'ops-shell', 'ops-ptc', 'ops-discovery', 'ops-sdk'].map(id => ({ id, disabled: true }))]);
  const input = `You are an offline bounded interface optimizer. Return ONLY a JSON object containing exactly the genome gene keys; no markdown. Never weaken protected contracts. Edit only gene strings within declared bounds. Focus on expensive successful trajectories, not only failures. Do not use tools, delegate, edit files, reveal credentials or run commands. Parent crossover/mutation is allowed.\nLane: ${JSON.stringify(lane)}\nParents: ${JSON.stringify(parents)}\nAggregate training feedback (no held-out tasks): ${JSON.stringify(feedback)}\nPropose one distinct candidate.`;
  const launcher = dshLaunch(config.runner);
  const guard = usageGuard(config);
  const { stdout } = await captureExecution(dir, launcher.command, [...launcher.args, '--profile', config.runner.profile, '--patch', patchFile, '--json'], { cwd: dir, env: { DSH_HOME: config.runner.home, DSH_PERMISSION_MODE: 'read-only' }, input, timeoutMs: config.runner.timeoutMs, onStdout: guard });
  const result = await reconcileUsage(config, dir, parseHeadless(stdout));
  await save(path.join(dir, 'receipt.json'), { ...result, answer: undefined, answerHash: hash(result.answer) });
  assert(result.completed, 'Optimizer did not complete');
  // Parsing/validation failures are still charged: caller records usage before validating the genome.
  return { text: result.answer, tokens: result.tokens, usage: result.usage, steps: result.steps, usageSource: result.usageSource, ...(result.usageUnknown ? { usageUnknown: true, usageGaps: result.usageGaps, recoveryEvidence: result.recoveryEvidence } : {}) };
}
