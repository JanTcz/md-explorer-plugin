import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openBrowser } from '../src/open.js';

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
