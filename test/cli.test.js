import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PORT, main } from '../src/cli.js';
import { get, project, SAMPLE } from './helpers.js';

function io(extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    opts: { stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, env: {}, ...extra },
  };
}

test('--help and bad options', async () => {
  const a = io();
  assert.equal(await main(['--help'], a.opts), 0);
  assert.match(a.out.join(''), /Usage:/);
  const b = io();
  assert.equal(await main(['--nope'], b.opts), 2);
  assert.match(b.err.join(''), /Unknown option: --nope/);
  for (const port of ['abc', '-1', '70000', '1.5']) {
    const c = io();
    assert.equal(await main(['--port', port], c.opts), 2, port);
    assert.match(c.err.join(''), /Bad port/);
  }
});

test('a folder that does not exist is an error', async () => {
  const a = io({ cwd: '/' });
  assert.equal(await main(['/definitely/not/here'], a.opts), 1);
  assert.match(a.err.join(''), /Not a folder/);
});

test('serves docs/ when it exists, else the current folder; prints the address; stops on exit', async () => {
  const p = await project(SAMPLE);
  const q = await project({ 'plain.md': '# plain' });
  try {
    for (const [cwd, expected] of [[p.dir, 'docs'], [q.dir, '']]) {
      const a = io({ cwd });
      let seen;
      a.opts.waitForExit = async () => {
        const url = /http:\/\/localhost:\d+\//.exec(a.out.join(''))[0];
        seen = (await get({ url }, '/api/info')).body.refBase;
      };
      assert.equal(await main(['--port', '0'], a.opts), 0);
      assert.equal(seen, expected);
    }
  } finally {
    await p.cleanup();
    await q.cleanup();
  }
});

test('dir and port come from arguments or the environment; --open launches the browser', async () => {
  const p = await project({ 'one/a.md': '# a', 'two/b.md': '# b' });
  try {
    const a = io({ cwd: p.dir, env: { MD_EXPLORER_ROOT: 'one', MD_EXPLORER_PORT: '0' } });
    a.opts.waitForExit = async () => {
      const url = /http:\/\/localhost:\d+\//.exec(a.out.join(''))[0];
      assert.deepEqual((await get({ url }, '/api/tree')).body.files.map(f => f.path), ['a.md']);
    };
    assert.equal(await main([], a.opts), 0);
    const b = io({ cwd: p.dir, env: { MD_EXPLORER_ROOT: 'one' } });
    b.opts.waitForExit = async () => {
      const url = /http:\/\/localhost:\d+\//.exec(b.out.join(''))[0];
      assert.deepEqual((await get({ url }, '/api/tree')).body.files.map(f => f.path), ['b.md']);
    };
    const opened = [];
    b.opts.open = async url => opened.push(url);
    assert.equal(await main(['two', '--port=0', '--open'], b.opts), 0);
    assert.match(opened[0], /^http:\/\/localhost:\d+\/$/);
    assert.equal(DEFAULT_PORT, 4477);
  } finally {
    await p.cleanup();
  }
});
