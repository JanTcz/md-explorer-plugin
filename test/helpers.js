import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A temp project with the given files (`{ 'docs/a.md': '# A' }`); `dir` is its root. */
export async function project(files) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'md-explorer-')));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return { dir, docs: path.join(dir, 'docs'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

export const SAMPLE = {
  'docs/README.md': '---\ntitle: x\n---\nIntro text.\n\n# Home\n\nHello `code`.\n\n## Part one\n\nText one.\n\n### Deep\n\nDeep text.\n\n## Part two\n\n```md\n# not a heading\n```\n\nEnd.\n',
  'docs/guide/start.md': '# Start\n\nBegin here.\n',
  'docs/img.png': 'not really a png',
  'docs/notes.txt': 'not markdown',
  'docs/.hidden/secret.md': '# secret\n',
  'docs/node_modules/x.md': '# dep\n',
};

export async function get(server, p, init) {
  const res = await fetch(new URL(p, server.url), init);
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
}

export const post = (server, p, body) =>
  get(server, p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
