// The documentation folder: which Markdown files it holds, their sections, and
// the references ("docs/a.md:12-40 (§ Parent > Heading)") that point into them.
// Pure functions and a little file system access; no HTTP in here.

import fs from 'node:fs/promises';
import path from 'node:path';

import { frontMatterLines } from './blocks.js';

export { excerpt, formatRef, parseRef } from './refs.js';
export { frontMatterLines };

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const SKIPPED_DIRS = new Set(['node_modules']);
const MAX_FILES = 5000;
const MAX_BYTES = 4 * 1024 * 1024;

export class DocsError extends Error {}

const toPosix = p => p.split(path.sep).join('/');

/** Every Markdown file under `root`: `{ path, size, mtimeMs }`, `path` relative to root with `/`. */
export async function scan(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && MARKDOWN.test(entry.name)) {
        const stat = await fs.stat(full);
        files.push({ path: toPosix(path.relative(root, full)), size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

/** Resolves a path given by the browser or by Claude to a file inside `root`, or throws. */
export async function resolveInside(root, rel, { markdownOnly = true } = {}) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) throw new DocsError('Missing path');
  const full = path.resolve(root, rel);
  let real;
  try {
    real = await fs.realpath(full);
  } catch {
    throw new DocsError(`Not found: ${rel}`);
  }
  const realRoot = await fs.realpath(root);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new DocsError(`Outside the docs folder: ${rel}`);
  if (markdownOnly && !MARKDOWN.test(real)) throw new DocsError(`Not a Markdown file: ${rel}`);
  return real;
}

export async function readDoc(root, rel) {
  const full = await resolveInside(root, rel);
  const stat = await fs.stat(full);
  if (!stat.isFile()) throw new DocsError(`Not a file: ${rel}`);
  if (stat.size > MAX_BYTES) throw new DocsError(`Too large (over 4 MiB): ${rel}`);
  const text = await fs.readFile(full, 'utf8');
  return { path: toPosix(path.relative(await fs.realpath(root), full)), text, mtimeMs: stat.mtimeMs, sections: sections(text) };
}

/** GitHub-style heading slug: lower case, punctuation dropped, spaces to dashes (letters of any script kept). */
export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

const stripInline = s => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').trim();

/**
 * The document as blocks cut at every heading:
 * `{ level, title, slug, breadcrumb, start, end, treeEnd }` (1-based inclusive lines).
 * Text before the first heading is a `level: 0` block. Fenced code and front matter hide headings.
 */
export function sections(text) {
  const lines = text.split('\n');
  const found = [];
  const seen = new Map();
  let fence = null;
  const skip = frontMatterLines(lines);
  for (let i = skip; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      continue;
    }
    const h = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (!h) continue;
    const title = stripInline(h[2]);
    const base = slugify(title);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    found.push({ level: h[1].length, title, slug: n ? `${base}-${n}` : base, start: i + 1 });
  }
  const out = [];
  const firstStart = found.length ? found[0].start : lines.length + 1;
  const hasPreamble = lines.slice(skip, firstStart - 1).some(l => l.trim() !== '');
  if (hasPreamble) out.push({ level: 0, title: '', slug: '', breadcrumb: [], start: skip + 1, end: firstStart - 1 });
  const trail = [];
  found.forEach((s, i) => {
    while (trail.length && trail[trail.length - 1].level >= s.level) trail.pop();
    trail.push(s);
    const end = i + 1 < found.length ? found[i + 1].start - 1 : lines.length;
    out.push({ ...s, breadcrumb: trail.map(t => t.title), end: trimEnd(lines, s.start, end) });
  });
  if (out.length && out[0].level === 0) out[0].end = trimEnd(lines, out[0].start, out[0].end);
  // `end` stops at the next heading of any level; `treeEnd` takes the subsections along.
  out.forEach((s, i) => {
    const next = out.slice(i + 1).find(n => n.level <= s.level);
    s.treeEnd = s.level === 0 ? s.end : next ? out[out.indexOf(next) - 1].end : out.at(-1).end;
  });
  return out;
}

// A block ends at its last non-blank line, so a reference does not drag the blank gap in.
function trimEnd(lines, start, end) {
  let e = Math.min(end, lines.length);
  while (e > start && lines[e - 1].trim() === '') e--;
  return e;
}

/** The title of a document: its first level-1 heading, else the file name. */
export function docTitle(text, file) {
  const h1 = sections(text).find(s => s.level === 1);
  return h1 ? h1.title : path.posix.basename(file).replace(MARKDOWN, '');
}
