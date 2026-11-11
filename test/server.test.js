import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { get, post, project, SAMPLE } from './helpers.js';

async function withServer(fn, files = SAMPLE, opts = {}) {
  const p = await project(files);
  const server = await startServer({ root: p.docs, cwd: p.dir, ...opts });
  try {
    await fn(server, p);
  } finally {
    await server.close();
    await p.cleanup();
  }
}

/** Opens the event stream; `next(name)` resolves to the data of the next event of that name. */
async function events(server) {
  const res = await fetch(new URL('/api/events', server.url));
  const reader = res.body.getReader();
  let buffer = '';
  const next = async name => {
    for (;;) {
      const m = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`).exec(buffer);
      if (m) {
        buffer = buffer.slice(m.index + m[0].length);
        return JSON.parse(m[1]);
      }
      const { value, done } = await reader.read();
      assert.ok(!done, `stream ended before ${name}`);
      buffer += new TextDecoder().decode(value);
    }
  };
  return { next, close: () => reader.cancel() };
}

test('serves the app, vendor files and the shared modules; nothing else from src', () =>
  withServer(async server => {
    assert.match((await get(server, '/')).body, /<title>md-explorer<\/title>/);
    const html = await get(server, '/');
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await get(server, '/vendor/marked.min.js')).status, 200);
    assert.equal((await get(server, '/shared/refs.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await get(server, '/shared/blocks.js')).status, 200);
    for (const bad of ['/shared/server.js', '/shared/docs.js', '/..%2fpackage.json', '/nope.txt', '/vendor']) {
      assert.equal((await get(server, bad)).status, 404, bad);
    }
    assert.equal((await get(server, '/', { method: 'DELETE' })).status, 405);
    assert.equal((await get(server, '/vendor/README.md')).headers.get('content-type'), 'application/octet-stream');
  }));

test('API: info, tree, file, index', () =>
  withServer(async (server, p) => {
    const info = (await get(server, '/api/info')).body;
    assert.deepEqual(info, { name: 'docs', refBase: 'docs' });
    const tree = (await get(server, '/api/tree')).body.files.map(f => f.path);
    assert.deepEqual(tree, ['guide/start.md', 'README.md']);
    const file = (await get(server, '/api/file?path=guide/start.md')).body;
    assert.equal(file.sections[0].title, 'Start');
    assert.equal((await get(server, '/api/file?path=../x.md')).status, 400);
    assert.equal((await get(server, '/api/file')).status, 400);
    const { docs } = (await get(server, '/api/index')).body;
    const part = docs.find(d => d.title === 'Part one');
    assert.deepEqual([part.path, part.start, part.end, part.breadcrumb], ['README.md', 10, 12, ['Home', 'Part one']]);
    assert.match(part.text, /Text one/);
    assert.ok(!part.text.includes('Part one'), 'the heading line is not in the body text');
    await fs.writeFile(path.join(p.docs, 'dir.md'), '');
    await fs.truncate(path.join(p.docs, 'dir.md'), 5 * 1024 * 1024);
    const again = (await get(server, '/api/index')).body.docs;
    assert.ok(!again.some(d => d.path === 'dir.md'), 'an unreadable file is left out of the index, not fatal');
  }));

test('refBase is empty when the docs folder is the project', async () => {
  const p = await project(SAMPLE);
  const server = await startServer({ root: p.docs, cwd: p.docs });
  try {
    assert.equal((await get(server, '/api/info')).body.refBase, '');
    assert.equal((await server.navigate('README.md:1')).target.ref, 'README.md:1');
    await post(server, '/api/selection', { path: 'README.md', start: 10 });
    assert.equal((await server.selection()).ref, 'README.md:10 (§ Home > Part one)');
  } finally {
    await server.close();
    await p.cleanup();
  }
});

test('raw serves images next to the docs, and only images', () =>
  withServer(async server => {
    const png = await get(server, '/api/raw?path=img.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('content-security-policy'), 'sandbox');
    assert.equal((await get(server, '/api/raw?path=notes.txt')).status, 415);
    assert.equal((await get(server, '/api/raw?path=README')).status, 400);
    assert.equal((await get(server, '/api/raw?path=../package.json')).status, 400);
    assert.equal((await get(server, '/api/nothing')).status, 404);
  }));

test('guards: Host header (DNS rebinding), Origin, and JSON-only writes', () =>
  withServer(async server => {
    const port = server.port;
    const raw = (headers, method = 'GET', p = '/api/tree') =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end(method === 'GET' ? undefined : '{}');
      });
    assert.equal(await raw({ host: `evil.example:${port}` }), 403);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, origin: 'http://evil.example' }), 403);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` }), 200);
    assert.equal(await raw({ host: `localhost:${port}` }), 200);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, 'POST', '/api/selection'), 415);
    assert.equal(await raw({ host: `127.0.0.1:${port}` }, 'POST', '/api/selection'), 415);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, 'POST', '/api/tree'), 404);
    assert.equal(await raw({ host: `127.0.0.1:${port}`, 'content-type': 'application/json' }, 'PUT', '/api/selection'), 404);
  }));

test('selection: set, read back with breadcrumb and text, clamp, clear, validate', () =>
  withServer(async server => {
    assert.deepEqual((await get(server, '/api/selection')).body, { selection: null });
    const set = await post(server, '/api/selection', { path: 'README.md', start: 10, end: 16 });
    assert.equal(set.status, 200);
    assert.equal(set.body.selection.ref, 'docs/README.md:10-16 (§ Home > Part one)');
    assert.equal(set.body.selection.section, 'Home > Part one');
    assert.match(set.body.selection.text, /^## Part one\n\nText one\./);
    assert.deepEqual(await server.selection(), (await get(server, '/api/selection')).body.selection);
    const single = await post(server, '/api/selection', { path: 'README.md', start: 4 });
    assert.equal(single.body.selection.ref, 'docs/README.md:4');
    assert.equal(single.body.selection.section, undefined);
    const clamped = await post(server, '/api/selection', { path: 'README.md', start: 5, end: 9999 });
    assert.equal(clamped.body.selection.end, 25);
    assert.equal((await post(server, '/api/selection', { path: 'README.md', start: 9999 })).body.selection.start, 25);
    for (const bad of [{ path: 'README.md', start: 0 }, { path: 'README.md', start: 'x' }, { path: 'README.md', start: 5, end: 2 }, { path: 'nope.md', start: 1 }, {}]) {
      assert.equal((await post(server, '/api/selection', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await post(server, '/api/selection', { clear: true })).body.selection, null);
    assert.equal(await server.selection(), null);
  }));

test('selection of a file that is gone reads as nothing', () =>
  withServer(async (server, p) => {
    await post(server, '/api/selection', { path: 'guide/start.md', start: 1 });
    await fs.rm(path.join(p.docs, 'guide', 'start.md'));
    assert.equal(await server.selection(), null);
  }));

test('bad JSON and a huge body are refused; other errors are 500', () =>
  withServer(async server => {
    const init = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal((await get(server, '/api/selection', init('{nope'))).status, 400);
    assert.equal((await get(server, '/api/selection', init(' ' + 'x'.repeat(70_000)))).status, 400);
    assert.equal((await get(server, '/api/selection', init(''))).status, 400); // {} has no path
    assert.equal((await get(server, '/%E0%A4%A0%'.replace('%E0%A4%A0%', '%'))).status, 500);
  }));

test('navigate resolves project-relative refs, docs-relative refs and slugs; tells every tab', () =>
  withServer(async server => {
    const stream = await events(server);
    const a = await server.navigate('docs/README.md:10-12 (§ Home > Part one)');
    assert.deepEqual(await stream.next('navigate'), { path: 'README.md', start: 10, end: 12 });
    assert.equal(a.tabs, 1);
    assert.equal(a.target.ref, 'docs/README.md:10-12');
    const b = await server.navigate('guide/start.md#start');
    assert.deepEqual(await stream.next('navigate'), { path: 'guide/start.md', start: 1, end: 3 });
    assert.equal(b.target.ref, 'docs/guide/start.md:1-3');
    await server.navigate('README.md');
    assert.deepEqual(await stream.next('navigate'), { path: 'README.md' });
    await assert.rejects(server.navigate('docs/README.md#nope'), /No section #nope/);
    await assert.rejects(server.navigate('docs/missing.md:1'), /Not found in the docs folder/);
    await assert.rejects(server.navigate('../README.md'), /Not found in the docs folder/);
    await assert.rejects(server.navigate('hello'), /Not a reference/);
    await stream.close();
  }));

test('POST /api/navigate points the tabs and answers where; a bad ref is a 400', () =>
  withServer(async server => {
    const stream = await events(server);
    await new Promise(r => setTimeout(r, 50));
    const res = await post(server, '/api/navigate', { ref: 'docs/README.md:10-12' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { target: { path: 'README.md', start: 10, end: 12, ref: 'docs/README.md:10-12' }, tabs: 1 });
    assert.deepEqual(await stream.next('navigate'), { path: 'README.md', start: 10, end: 12 });
    assert.equal((await post(server, '/api/navigate', {})).status, 400);
    assert.equal((await post(server, '/api/navigate', { ref: 'docs/nope.md' })).status, 400);
    await stream.close();
  }));

test('navigate without tabs says so; tabs() counts open streams', () =>
  withServer(async server => {
    assert.equal(server.tabs(), 0);
    assert.equal((await server.navigate('docs/README.md:1')).tabs, 0);
    const stream = await events(server);
    await stream.close();
  }));

test('a change in the docs folder is announced (debounced)', () =>
  withServer(async (server, p) => {
    const stream = await events(server);
    await new Promise(r => setTimeout(r, 100));
    await fs.writeFile(path.join(p.docs, 'new.md'), '# new');
    await fs.writeFile(path.join(p.docs, 'new.md'), '# newer');
    assert.deepEqual(await stream.next('changed'), {});
    await stream.close();
  }));

test('a busy port falls back to a free one only when asked to', async () => {
  const p = await project(SAMPLE);
  const first = await startServer({ root: p.docs, cwd: p.dir });
  try {
    await assert.rejects(startServer({ root: p.docs, cwd: p.dir, port: first.port }), { code: 'EADDRINUSE' });
    const second = await startServer({ root: p.docs, cwd: p.dir, port: first.port, fallback: true });
    assert.notEqual(second.port, first.port);
    await second.close();
    await assert.rejects(startServer({ root: p.docs, cwd: p.dir, port: 99999, fallback: true }), RangeError);
    await assert.rejects(startServer({ root: p.docs, cwd: p.dir, host: '203.0.113.1' }), { code: 'EADDRNOTAVAIL' });
  } finally {
    await first.close();
    await p.cleanup();
  }
});

test('event streams get a keep-alive ping', () =>
  withServer(
    async server => {
      const stream = await events(server);
      assert.deepEqual(await stream.next('ping'), {});
      await stream.close();
    },
    SAMPLE,
    { pingMs: 20 },
  ));
