import path from 'node:path';
import zlib from 'node:zlib';
import { readFile, readdir } from 'node:fs/promises';

// Recovery is best-effort and deliberately optional: it reads DSH's own private
// session archive to recover usage that the headless projection dropped. When it
// cannot recover every gap it reports nothing usable, so the caller still fails
// closed on genuinely unknown billing instead of guessing.

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

// DSH appends one zstd frame per flush, so a session log is many concatenated
// frames and a single-shot decompress returns only the first one. Each frame is
// independently decodable, so scan for frame magic and decode from each start.
// A false positive simply fails to decode and is skipped.
export function decodeZstdFrames(buffer) {
  const decompress = zlib.zstdDecompressSync;
  if (typeof decompress !== 'function') return null; // Node without zstd support: caller degrades gracefully.
  const starts = [];
  for (let i = 0; i + 3 < buffer.length; i++) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1] && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  if (!starts.length) return null;
  const parts = [];
  for (const start of starts) {
    try { parts.push(decompress(buffer.subarray(start)).toString('utf8')); }
    catch { /* Truncated or false-positive frame: skip it, do not discard the whole log. */ }
  }
  return parts.length ? parts.join('') : null;
}

// Same normalized counters the headless projection is supposed to carry.
function validUsage(usage) {
  if (!usage || typeof usage !== 'object') return false;
  for (const key of ['inputTokens', 'outputTokens']) if (!Number.isSafeInteger(usage[key]) || usage[key] < 0) return false;
  for (const key of ['cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (usage[key] !== undefined && (!Number.isSafeInteger(usage[key]) || usage[key] < 0)) return false;
  }
  return true;
}

// Look up one DSH session archive by session id and sum the per-step usage that
// the headless stream omitted. Returns null whenever the answer would be a guess.
export async function recoverSessionUsage({ home, sessionId, gaps }) {
  if (typeof home !== 'string' || !home || typeof sessionId !== 'string' || !sessionId) return null;
  if (!Array.isArray(gaps) || !gaps.length) return null;
  const wanted = new Set(gaps.map(gap => `${gap.turn}/${gap.step}`));
  let entries;
  try { entries = await readdir(path.join(home, 'sessions')); }
  catch { return null; } // No archive in this home: nothing to recover from.
  for (const entry of entries) {
    // A DSH session id may already carry the "session-" prefix, so both layouts are
    // accepted; guessing one and missing the archive would look like "no recovery"
    // instead of "wrong path".
    for (const relative of [`${entry}/${sessionId}/session.v4.jsonl.zstd`, `${entry}/session-${sessionId}/session.v4.jsonl.zstd`]) {
      let text;
      try { text = decodeZstdFrames(await readFile(path.join(home, 'sessions', relative))); }
      catch { continue; }
      if (!text) continue;
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
      const found = new Set();
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        // The archive keeps usage on the assistant message of the step, including
        // steps that succeeded only after a provider retry.
        if (event.type !== 'assistant/message') continue;
        const data = event.data;
        const key = `${data?.turn}/${data?.step}`;
        if (!wanted.has(key) || found.has(key) || !validUsage(data?.usage)) continue;
        found.add(key);
        for (const name of Object.keys(usage)) usage[name] += data.usage[name] ?? 0;
      }
      if (!found.size) continue;
      const missingSteps = [...wanted].filter(key => !found.has(key));
      return { usage, recoveredSteps: [...found], missingSteps, complete: missingSteps.length === 0, source: 'dsh-session-archive', file: relative };
    }
  }
  return null;
}
