import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { hash, random, safeFile, load } from '../src/common.mjs';
import { baseline, breed, validateLane, validateGenome, select } from '../src/genome.mjs';
import { parseHeadless, prepareTask, verify, runtimePatch } from '../src/runner.mjs';
import { readConfig } from '../src/config.mjs';
import { runSearch, validateFinal, exportWinner, Budget, withState } from '../src/search.mjs';
import { applyEdits, adapterCall } from '../src/adapter.mjs';
import { execute } from '../src/process.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'ops-ga-test-'));
const lane = { id: 'test', protectedPolicy: 'Never bypass authorization.', genes: { mode: { type: 'choice', initial: 'full', values: ['full', 'compact'] }, text: { type: 'text', initial: 'keep CAS', maxChars: 100, required: ['CAS'] } } };
function stream(usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 3, reasoningTokens: 2, totalTokens: 37 }, reason = 'completed') {
  return [{ type: 'session', sessionId: 's1' }, { type: 'status', phase: 'step_end', usage }, { type: 'status', phase: 'turn_end', reason: { kind: reason } }, { type: 'final', text: 'answer' }].map(JSON.stringify).join('\n');
}
async function config() {
  const c = await readConfig('examples/demo.json');
  c.output = await tmp(); c.lanes = [lane]; c.fingerprint = hash({ ...c, fingerprint: undefined }); return c;
}

test('canonical hash ignores object insertion order', () => assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 })));
test('seeded mutation and crossover are deterministic and bounded', () => {
  validateLane(lane);
  const a = breed(lane, baseline(lane), baseline(lane), random(3));
  assert.deepEqual(a, breed(lane, baseline(lane), baseline(lane), random(3)));
  assert.throws(() => validateGenome(lane, { ...a, text: 'drop' }), /protected/);
  assert.throws(() => validateGenome(lane, { ...a, unexpected: 'yes' }), /keys/);
  assert.throws(() => validateGenome(lane, { ...a, mode: 'other' }), /choice/);
});
test('usage counts cached input, does not double count reasoning', () => assert.equal(parseHeadless(stream()).tokens, 37));
test('missing, inconsistent, negative usage is never scored as zero', () => {
  assert.throws(() => parseHeadless(stream(null)), /usage/);
  assert.throws(() => parseHeadless(stream({ inputTokens: -1, outputTokens: 2 })), /inputTokens/);
  assert.throws(() => parseHeadless(stream({ inputTokens: 10, outputTokens: 2, totalTokens: 100 })), /Inconsistent/);
});
test('terminal completion is required separately from final text', () => {
  assert.equal(parseHeadless(stream(undefined, 'error')).completed, false);
  assert.throws(() => parseHeadless('{}'), /session/);
  assert.throws(() => parseHeadless(stream().replace(/\n[^\n]+$/, '')), /final/);
});
test('protected runtime overlay pins route and disables hidden model costs', () => {
  const patch = runtimePatch({ provider: 'p', model: 'm', permission: 'read-only' });
  assert.equal(patch.find(x => x.id === 'sandbox-policy').config.mode, 'read-only');
  assert.equal(patch.find(x => x.id === 'tool-subagent').disabled, true);
  assert.equal(patch.find(x => x.id === 'compaction-basic').disabled, true);
});
test('candidate with safety failure or paired regression cannot win', () => {
  const reference = { id: 'base', successes: 1, tokens: 100, results: [{ success: true, safety: true }] };
  const cheaperFailure = { ...reference, id: 'bad', tokens: 1, successes: 0, results: [{ success: false, safety: true }] };
  const unsafe = { ...reference, id: 'unsafe', tokens: 1, results: [{ success: true, safety: false }] };
  assert.deepEqual(select([reference, cheaperFailure, unsafe], reference).map(r => r.id), ['base']);
});
test('fixture paths cannot escape, content checks execute outside the model', async () => {
  const dir = await tmp();
  const task = { files: { 'x/a.txt': 'hi' }, check: { type: 'file-equals', path: 'x/a.txt', value: 'hi' } };
  const workspace = await prepareTask(dir, task);
  assert.equal(await verify(task, workspace, ''), true);
  assert.equal(await verify({ ...task, check: { ...task.check, value: 'no' } }, workspace, ''), false);
  await assert.rejects(() => safeFile(workspace, '../outside'), /escapes/);
  await assert.rejects(() => safeFile(workspace, 'x\\a'), /POSIX/);
  // A normal temp path may resolve through Windows 8.3 short names; that alias is not a symlink.
  assert.equal(await safeFile(workspace, 'x/a.txt'), path.join(workspace, 'x', 'a.txt'));
  try { await symlink(dir, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return; throw error; }
  await assert.rejects(() => safeFile(workspace, 'link/file'), /Symlink/);
  // The sandbox root itself must still be rejected when it resolves through a link.
  await assert.rejects(() => safeFile(path.join(workspace, 'link'), 'file'), /symlink/i);
});
test('budget reserves before launch, counts proposals, refuses further calls', async () => {
  const state = { budget: { calls: 0, episodes: 0, tokens: 0 } };
  const budget = new Budget({ runner: { type: 'mock' }, budget: { maxCalls: 2, maxEpisodes: 1, maxTokens: 100, reserveTokensPerCall: 50 } }, state, async () => {});
  await budget.reserve(false); await budget.settle(20);
  await budget.reserve(true); await budget.settle(50);
  assert.equal(state.budget.calls, 2); assert.equal(state.budget.episodes, 1);
  assert.equal(state.budget.tokens, 70); assert.equal(state.budget.pending, false);
  assert.equal(state.budget.accountingUnit, 'session-invocation');
  assert.equal(state.budget.unknownStepInvocations, 2);
  await assert.rejects(() => budget.reserve(false), /exhausted/);
});
test('budget catches real overshoot rather than hiding it', async () => {
  const state = { budget: { calls: 0, episodes: 0, tokens: 0 } };
  const budget = new Budget({ runner: { type: 'mock' }, budget: { maxCalls: 2, maxEpisodes: 2, maxTokens: 100, reserveTokensPerCall: 50 } }, state, async () => {});
  await budget.reserve(true); await assert.rejects(() => budget.settle(101), /overshot/);
  assert.equal(state.budget.tokens, 101);
});
test('end-to-end mock evolution resumes, freezes holdout, forbids synthetic export', async () => {
  const c = await config();
  const result = await runSearch(c, lane);
  const resumed = await runSearch(c, lane);
  assert.equal(result.budget.calls, resumed.budget.calls);
  const final = await validateFinal(c, lane);
  assert.equal(final.synthetic, true);
  assert.equal(final.statisticalNonInferiorityProven, false);
  assert.deepEqual(final, await validateFinal(c, lane));
  await assert.rejects(() => runSearch(c, lane), /holdout/);
  await assert.rejects(() => exportWinner(c, lane, path.join(c.output, 'export.json')), /real/);
});
test('configuration fingerprint blocks stale evaluation reuse', async () => {
  const c = await config(); await runSearch(c, lane);
  await assert.rejects(() => runSearch({ ...c, fingerprint: 'changed' }, lane), /Configuration changed/);
});
test('same lane is protected by an exclusive lock', async () => {
  const c = await config();
  await withState(c, lane, async () => { await assert.rejects(() => withState(c, lane, async () => {}), /locked/); });
});
test('uncertain billed call blocks automatic resume and retains reservation', async () => {
  const c = await config();
  await withState(c, lane, async ({ budget }) => { await budget.reserve(true); });
  await assert.rejects(() => runSearch(c, lane), /unknown call/);
});
test('bounded source edits require allowlist, exact match and source hash', async () => {
  const root = await tmp(); await writeFile(path.join(root, 'a.ts'), 'old text');
  const edit = { path: 'a.ts', sha256: hash('old text'), oldText: 'old', newText: 'new' };
  await assert.rejects(() => applyEdits(root, [edit], []), /allowlist/);
  await applyEdits(root, [edit], ['a.ts']);
  assert.equal(await readFile(path.join(root, 'a.ts'), 'utf8'), 'new text');
  await assert.rejects(() => applyEdits(root, [edit], ['a.ts']), /hash changed/);
});
test('process adapter uses argv without shell interpretation', async () => {
  const result = await execute(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', '$(bad); & x']);
  assert.equal(result.stdout, '$(bad); & x');
});
test('trusted adapter subprocess round-trip is bounded and typed by caller', async () => {
  const root = await tmp(); const module = path.join(root, 'plugin.mjs');
  await writeFile(module, 'export async function evaluate(r) { return { success:true,safety:true,tokens:12,synthetic:true, seen:r.task.id }; }');
  const result = await adapterCall({ runner: { module, timeoutMs: 1000 } }, 'evaluate', { task: { id: 'a' } }, path.join(root, 'call'));
  assert.equal(result.seen, 'a');
});
