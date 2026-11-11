import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createTools, handle, openBrowser, serve, TOOLS } from '../src/mcp.js';
import { startServer } from '../src/server.js';
import { post, project, SAMPLE } from './helpers.js';

async function withTools(fn) {
  const p = await project(SAMPLE);
  const server = await startServer({ root: p.docs, cwd: p.dir });
  const opened = [];
  const tools = createTools(server, async url => (opened.push(url), true));
  try {
    await fn({ tools, server, opened });
  } finally {
    await server.close();
    await p.cleanup();
  }
}

const call = (tools, name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools);
const parse = r => JSON.parse(r.result.content[0].text);

test('initialize answers the protocol version, tools and instructions; notifications get no answer', async () => {
  const init = await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, {});
  assert.equal(init.result.protocolVersion, '2024-11-05');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.match(init.result.instructions, /explorer_selection/);
  assert.equal((await handle({ id: 2, method: 'initialize' }, {})).result.protocolVersion, '2025-06-18');
  assert.equal(await handle({ method: 'notifications/initialized' }, {}), undefined);
  assert.deepEqual((await handle({ id: 3, method: 'ping' }, {})).result, {});
  assert.deepEqual((await handle({ id: 4, method: 'tools/list' }, {})).result.tools.map(t => t.name), TOOLS.map(t => t.name));
  assert.equal((await handle({ id: 5, method: 'nope' }, {})).error.code, -32601);
});

test('explorer_selection reports what the browser selected, or that nothing is', () =>
  withTools(async ({ tools, server }) => {
    assert.match((await call(tools, 'explorer_selection', {})).result.content[0].text, /Nothing is selected.*no tab is open/);
    const stream = await fetch(new URL('/api/events', server.url));
    assert.match((await call(tools, 'explorer_selection')).result.content[0].text, /Nothing is selected/);
    assert.doesNotMatch((await call(tools, 'explorer_selection')).result.content[0].text, /no tab is open/);
    await post(server, '/api/selection', { path: 'guide/start.md', start: 1, end: 3 });
    const sel = parse(await call(tools, 'explorer_selection', {}));
    assert.equal(sel.ref, 'docs/guide/start.md:1-3 (§ Start)');
    assert.equal(sel.text, '# Start\n\nBegin here.');
    await stream.body.cancel();
  }));

test('explorer_open points the browser, or says no tab is open; a bad ref is a tool error', () =>
  withTools(async ({ tools, server }) => {
    const none = parse(await call(tools, 'explorer_open', { ref: 'docs/README.md:10' }));
    assert.equal(none.tabs, 0);
    assert.match(none.note, new RegExp(server.url));
    const stream = await fetch(new URL('/api/events', server.url));
    await new Promise(r => setTimeout(r, 50));
    const shown = parse(await call(tools, 'explorer_open', { ref: 'docs/README.md:10' }));
    assert.deepEqual(shown, { shown: 'docs/README.md:10', tabs: 1 });
    const bad = await call(tools, 'explorer_open', { ref: 'docs/missing.md' });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Not found/);
    await stream.body.cancel();
  }));

test('explorer_url gives the address and opens the browser only when asked', () =>
  withTools(async ({ tools, server, opened }) => {
    assert.deepEqual(parse(await call(tools, 'explorer_url', {})), { url: server.url, root: server.root, tabs: 0, opened: false });
    assert.equal(parse(await call(tools, 'explorer_url')).opened, false);
    assert.equal(parse(await call(tools, 'explorer_url', { open: true })).opened, true);
    assert.deepEqual(opened, [server.url]);
  }));

test('unknown tools (also inherited names) are a protocol error; other failures are internal errors', async () => {
  assert.equal((await call({}, 'nope', {})).error.code, -32602);
  assert.equal((await call({}, 'toString', {})).error.code, -32602);
  assert.equal((await call({}, undefined, {})).error.code, -32602);
  await assert.rejects(call({ boom: () => Promise.reject(new Error('boom')) }, 'boom', {}), /boom/);
});

test('serve speaks line-delimited JSON-RPC and survives garbage', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  output.on('data', d => lines.push(...String(d).trim().split('\n').map(l => JSON.parse(l))));
  const done = serve({ boom: () => Promise.reject(new Error('kaboom')) }, input, output);
  input.write('\n{not json\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'boom' } }) + '\n');
  input.end();
  await done;
  assert.equal(lines.find(l => l.id === 7).result && true, true);
  assert.equal(lines.find(l => l.error?.code === -32700).id, null);
  assert.equal(lines.find(l => l.id === 8).error.message, 'kaboom');
  assert.equal(lines.length, 3);
});

test('openBrowser picks the launcher of the platform and reports one that cannot start', async () => {
  const fake = outcome => {
    const calls = [];
    const launch = (cmd, args, options) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter();
      child.unref = () => calls.push('unref');
      setImmediate(() => child.emit(outcome, new Error('ENOENT')));
      assert.deepEqual(options, { stdio: 'ignore', detached: true });
      return child;
    };
    return { calls, launch };
  };
  for (const [platform, expected] of [['darwin', ['open', 'http://x/']], ['win32', ['cmd', '/c', 'start', '', 'http://x/']], ['linux', ['xdg-open', 'http://x/']]]) {
    const f = fake('spawn');
    assert.equal(await openBrowser('http://x/', platform, f.launch), true);
    assert.deepEqual(f.calls, [expected, 'unref']);
  }
  assert.equal(await openBrowser('http://x/', 'linux', fake('error').launch), false);
});
