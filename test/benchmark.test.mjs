import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { importSWE } from '../benchmarks/import-swe.mjs';
import { initialize } from '../src/init.mjs';
import { usageGuard, parseHeadless } from '../src/runner.mjs';
import { recoverSessionUsage } from '../src/session-usage.mjs';
import { Budget } from '../src/search.mjs';
import { select } from '../src/genome.mjs';

test('SWE import strips gold/test patches and rejects overlapping splits', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-swe-'));
  const source = path.join(root, 'rows.json'), out = path.join(root, 'tasks.json');
  await writeFile(source, JSON.stringify(['a__b-1', 'a__b-2', 'a__b-3'].map(instance_id => ({ instance_id, repo: 'a/b', base_commit: 'a'.repeat(40), problem_statement: 'Fix it', patch: 'GOLD', test_patch: 'TEST' }))));
  const options = { dataset: 'SWE-bench/SWE-bench_Lite', revision: 'pinned', repositoryRoot: root, groups: { train: ['a__b-1'], gate: ['a__b-2'], test: ['a__b-3'] } };
  await importSWE(source, out, options);
  const text = await readFile(out, 'utf8'); assert(!text.includes('GOLD')); assert(!text.includes('TEST'));
  await assert.rejects(() => importSWE(source, out, { ...options, groups: { train: ['a__b-1'], gate: ['a__b-1'], test: ['a__b-3'] } }), /Overlapping/);
});
test('Web handoff init requires explicit budget and never overwrites config', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-init-')), file = path.join(root, 'private.json');
  await assert.rejects(() => initialize(file, { confirm: true }), /explicit/);
  await assert.rejects(() => initialize(file, { budgetUSD: 2 }), /approval/);
  await initialize(file, { budgetUSD: 2, confirm: true });
  const config = JSON.parse(await readFile(file)); assert.equal(config.budget.maxUSD, 2); assert.equal(config.budget.confirmedByUser, true); assert(config.lanes[0].endsWith('operations.json'));
  await assert.rejects(() => initialize(file, { budgetUSD: 2, confirm: true }), /overwrite/);
});
test('live usage guard stops at reservation and records missing usage as a gap', () => {
  const guard = usageGuard({ budget: { reserveTokensPerCall: 100 } });
  guard(JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 40, outputTokens: 10 } }) + '\n');
  // Missing or malformed usage is a missing measurement, not evidence of overspend:
  // it must not terminate the invocation.
  guard(JSON.stringify({ type: 'status', phase: 'step_end', turn: 2, step: 1 }) + '\n');
  guard(JSON.stringify({ type: 'status', phase: 'step_end', turn: 2, step: 2, usage: { inputTokens: -1, outputTokens: 0 } }) + '\n');
  assert.deepEqual(guard.usageGaps, [{ turn: 2, step: 1 }, { turn: 2, step: 2 }]);
  // The real overspend signal still stops the owned process.
  assert.throws(() => guard(JSON.stringify({ type: 'status', phase: 'step_end', turn: 3, step: 1, usage: { inputTokens: 99, outputTokens: 1 } }) + '\n'), /reservation reached/);
});
test('headless parse keeps unaccounted steps visible instead of failing the invocation', () => {
  const text = [
    { type: 'session', sessionId: 's1' },
    { type: 'status', phase: 'step_start', turn: 1, step: 1 },
    { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 } },
    { type: 'status', phase: 'step_start', turn: 1, step: 2 },
    { type: 'status', phase: 'step_end', turn: 1, step: 2 },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    { type: 'final', text: 'done' }
  ].map(JSON.stringify).join('\n');
  const parsed = parseHeadless(text);
  assert.equal(parsed.usageComplete, false);
  assert.deepEqual(parsed.usageGaps, [{ turn: 1, step: 2 }]);
  assert.equal(parsed.tokens, 17); // Known steps are still counted.
});
test('an unaccounted episode can never be selected as the winner', () => {
  const reference = { id: 'base', successes: 1, tokens: 100, results: [{ success: true, safety: true }] };
  const cheaperButUnaccounted = { ...reference, id: 'gap', tokens: 1, results: [{ success: true, safety: true, selectionEligible: false }] };
  assert.deepEqual(select([reference, cheaperButUnaccounted], reference).map(r => r.id), ['base']);
});
test('unaccounted settlement charges the reservation, records the gap and lets the run continue', async () => {
  const config = { runner: { type: 'dsh' }, budget: { currency: 'USD', maxUSD: 1, reserveUSDPerCall: 0.2, reserveTokensPerCall: 100, maxTokens: 10000, maxCalls: 10, maxEpisodes: 10 } };
  const state = { budget: { calls: 0, episodes: 0, tokens: 0 } };
  const budget = new Budget(config, state, async () => {});
  await budget.reserve(true);
  assert.equal(state.budget.tokens, 100);
  await budget.settle({ usageUnknown: true, usageGaps: [{ turn: 1, step: 2 }], usageSource: 'unrecovered' });
  // Unknown usage stays charged at the full reservation: the ledger can never under-bill.
  assert.equal(state.budget.pending, false);
  assert.equal(state.budget.tokens, 100);
  assert.equal(state.budget.costMicros, 200000);
  assert.equal(state.budget.unknownUsageInvocations, 1);
  assert.equal(state.budget.unknownUsage[0].chargedTokens, 100);
  await budget.reserve(false); // The campaign is not blocked by an unaccounted invocation.
});
test('session archive recovery reads multi-frame logs and refuses partial answers', async () => {
  if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') return; // Node without zstd support.
  const home = await mkdtemp(path.join(os.tmpdir(), 'ops-ga-usage-home-'));
  const dir = path.join(home, 'sessions', 'label', 'session-s9');
  await mkdir(dir, { recursive: true });
  const line = (turn, step, usage) => JSON.stringify({ type: 'assistant/message', data: { turn, step, usage } });
  // DSH appends one frame per flush; two frames prove the scanner does not stop at the first.
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(line(1, 2, { inputTokens: 7, outputTokens: 3 }) + '\n')),
    zlib.zstdCompressSync(Buffer.from(line(1, 3, { inputTokens: 2, outputTokens: 1, cacheReadTokens: 4 }) + '\n'))
  ]));
  const full = await recoverSessionUsage({ home, sessionId: 's9', gaps: [{ turn: 1, step: 2 }, { turn: 1, step: 3 }] });
  assert.equal(full.complete, true);
  assert.equal(full.usage.inputTokens, 9);
  assert.equal(full.usage.outputTokens, 4);
  assert.equal(full.usage.cacheReadTokens, 4);
  // A real DSH session id already carries the "session-" prefix, so that layout must resolve too.
  const prefixed = await recoverSessionUsage({ home, sessionId: 'session-s9', gaps: [{ turn: 1, step: 2 }] });
  assert.equal(prefixed.complete, true);
  assert.equal(prefixed.usage.inputTokens, 7);
  const partial = await recoverSessionUsage({ home, sessionId: 's9', gaps: [{ turn: 1, step: 2 }, { turn: 9, step: 9 }] });
  assert.equal(partial.complete, false);
  assert.deepEqual(partial.missingSteps, ['9/9']);
  assert.equal(await recoverSessionUsage({ home, sessionId: 'absent', gaps: [{ turn: 1, step: 2 }] }), null);
  assert.equal(await recoverSessionUsage({ home, sessionId: 's9', gaps: [] }), null);
});
