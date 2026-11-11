import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DocsError, docTitle, excerpt, formatRef, frontMatterLines, parseRef, readDoc, resolveInside, scan, sections, slugify } from '../src/docs.js';
import { project, SAMPLE } from './helpers.js';

test('scan lists Markdown files only, sorted, without hidden folders and node_modules', async () => {
  const p = await project({ ...SAMPLE, 'docs/guide/10-b.md': '', 'docs/guide/2-a.MD': '' });
  try {
    const files = await scan(p.docs);
    assert.deepEqual(files.map(f => f.path), ['guide/2-a.MD', 'guide/10-b.md', 'guide/start.md', 'README.md']);
    assert.equal(typeof files[0].mtimeMs, 'number');
  } finally {
    await p.cleanup();
  }
});

test('scan stops at the file limit', async () => {
  const p = await project({ 'docs/a.md': '' });
  try {
    await Promise.all(Array.from({ length: 5002 }, (_, i) => fs.writeFile(path.join(p.docs, `f${i}.md`), '')));
    assert.equal((await scan(p.docs)).length, 5000);
  } finally {
    await p.cleanup();
  }
});

test('sections: levels, breadcrumbs, slugs, ranges; fences and front matter hide headings', () => {
  const s = sections(SAMPLE['docs/README.md']);
  assert.deepEqual(s.map(x => [x.level, x.title, x.start, x.end, x.treeEnd]), [
    [0, '', 4, 4, 4],
    [1, 'Home', 6, 8, 24],
    [2, 'Part one', 10, 12, 16],
    [3, 'Deep', 14, 16, 16],
    [2, 'Part two', 18, 24, 24],
  ]);
  assert.deepEqual(s[3].breadcrumb, ['Home', 'Part one', 'Deep']);
  assert.equal(s[3].slug, 'deep');
});

test('sections: duplicate titles get numbered slugs, inline markup and closing hashes are dropped', () => {
  const s = sections('## A\n## A\n## [Link](x) `code` ##\n');
  assert.deepEqual(s.map(x => x.slug), ['a', 'a-1', 'link-code']);
  assert.equal(s[2].title, 'Link code');
});

test('sections: a tilde fence closes only with its own kind; blank text is no preamble; empty text has none', () => {
  const s = sections('\n\n~~~\n# in\n```\n# still in\n~~~\n# out\n');
  assert.deepEqual(s.map(x => x.title), ['', 'out']);
  assert.deepEqual(sections(''), []);
  assert.deepEqual(sections('\n\n# A\n').map(x => x.level), [1]);
  assert.deepEqual(sections('plain only').map(x => [x.level, x.start, x.end]), [[0, 1, 1]]);
});

test('sections: front matter without a closing fence is plain text', () => {
  assert.equal(frontMatterLines(['---', 'a: 1', '---', 'x']), 3);
  assert.equal(frontMatterLines(['---', 'a: 1']), 0);
  assert.equal(frontMatterLines(['x']), 0);
});

test('slugify keeps letters of any script and drops punctuation', () => {
  assert.equal(slugify('Rozhodnutí: co? A <b>proč</b>'), 'rozhodnutí-co-a-proč');
});

test('docTitle: first level-1 heading, else the file name', () => {
  assert.equal(docTitle('text\n# Hello\n', 'a/b.md'), 'Hello');
  assert.equal(docTitle('## only\n', 'a/b-c.md'), 'b-c');
});

test('formatRef and parseRef round-trip', () => {
  assert.equal(formatRef({ path: 'docs/a.md' }), 'docs/a.md');
  assert.equal(formatRef({ path: 'docs/a.md', start: 3 }), 'docs/a.md:3');
  assert.equal(formatRef({ path: 'docs/a.md', start: 3, end: 3 }), 'docs/a.md:3');
  assert.equal(formatRef({ path: 'docs/a.md', start: 3, end: 9, breadcrumb: ['A', 'B'] }), 'docs/a.md:3-9 (§ A > B)');
  assert.deepEqual(parseRef('docs/a.md:3-9 (§ A > B)'), { path: 'docs/a.md', slug: undefined, start: 3, end: 9 });
  assert.deepEqual(parseRef('@docs/a.md:4'), { path: 'docs/a.md', slug: undefined, start: 4, end: 4 });
  assert.deepEqual(parseRef('docs/a.md#part-one'), { path: 'docs/a.md', slug: 'part-one', start: undefined, end: undefined });
  assert.deepEqual(parseRef('docs/a.md'), { path: 'docs/a.md', slug: undefined, start: undefined, end: undefined });
  assert.equal(parseRef('docs/a.txt:3'), undefined);
  assert.equal(parseRef(undefined), undefined);
});

test('excerpt takes inclusive 1-based lines and clamps', () => {
  assert.equal(excerpt('a\nb\nc\nd', 2, 3), 'b\nc');
  assert.equal(excerpt('a\nb', 2), 'b');
  assert.equal(excerpt('a\nb', 0, 99), 'a\nb');
  assert.equal(excerpt('a\nb', 2, 1), 'b');
});

test('resolveInside refuses what is outside, missing, not Markdown or odd', async () => {
  const p = await project({ ...SAMPLE, 'outside.md': '# out' });
  try {
    await fs.symlink(path.join(p.dir, 'outside.md'), path.join(p.docs, 'link.md'));
    assert.match(await resolveInside(p.docs, 'guide/start.md'), /start\.md$/);
    assert.match(await resolveInside(p.docs, 'img.png', { markdownOnly: false }), /img\.png$/);
    for (const bad of ['../outside.md', 'link.md', 'nope.md', 'img.png', '', 'a\0.md', undefined]) {
      await assert.rejects(resolveInside(p.docs, bad), DocsError, String(bad));
    }
    assert.equal(await resolveInside(p.docs, '.', { markdownOnly: false }), p.docs);
  } finally {
    await p.cleanup();
  }
});

test('readDoc returns text and sections; refuses folders and huge files', async () => {
  const p = await project({ ...SAMPLE, 'docs/big.md': '' });
  try {
    const doc = await readDoc(p.docs, 'guide/start.md');
    assert.equal(doc.path, 'guide/start.md');
    assert.equal(doc.sections[0].title, 'Start');
    await fs.mkdir(path.join(p.docs, 'dir.md'));
    await assert.rejects(readDoc(p.docs, 'dir.md'), /Not a file/);
    await fs.truncate(path.join(p.docs, 'big.md'), 5 * 1024 * 1024);
    await assert.rejects(readDoc(p.docs, 'big.md'), /Too large/);
  } finally {
    await p.cleanup();
  }
});
