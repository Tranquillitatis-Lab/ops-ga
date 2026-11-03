import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import path from 'node:path';

export const stable = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
export const load = async file => JSON.parse(await readFile(file, 'utf8'));
export async function save(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}
export function assert(condition, message) { if (!condition) throw new Error(message); }
export function integer(value, min, max, label) { assert(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${label}`); }
export function contained(root, file) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
async function assertNoSymlinkPath(target, message) {
  // Check each existing path component with lstat so Windows 8.3 aliases are not
  // mistaken for symlinks merely because realpath() expands them to long names.
  const absolute = path.resolve(target);
  const root = path.parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      assert(!(await lstat(cursor)).isSymbolicLink(), message);
    } catch (error) {
      // A missing final path is valid for safeFile; the caller may create it later.
      // Other filesystem errors must still fail closed.
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function safeFile(root, relative) {
  assert(typeof relative === 'string' && relative.length > 0 && !path.isAbsolute(relative) && !relative.includes('\\'), 'Expected relative POSIX file path');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  assert(contained(resolvedRoot, resolved), `Path escapes sandbox: ${relative}`);
  // Reject symlinks in the root's ancestry and within the requested relative path.
  // Comparing realpath(root) to the input string is not portable: Windows may
  // expand a valid short-name path without any symlink being present.
  await assertNoSymlinkPath(resolvedRoot, 'Sandbox root must not contain a symlink');
  const relativePath = path.relative(resolvedRoot, resolved);
  let cursor = resolvedRoot;
  for (const part of relativePath.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { assert(!(await lstat(cursor)).isSymbolicLink(), `Symlink forbidden: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}
export function random(seed) {
  let s = seed >>> 0;
  return () => { s += 0x6D2B79F5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
