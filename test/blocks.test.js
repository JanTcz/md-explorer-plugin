import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mapBlocks } from '../src/blocks.js';
import { SAMPLE } from './helpers.js';

// The vendored marked is a browser script that sets a global: run it the way the page does.
const context = {};
vm.runInNewContext(fs.readFileSync(new URL('../web/vendor/marked.min.js', import.meta.url), 'utf8'), context);
const marked = context.marked;

test('mapBlocks ties every rendered block to its source lines (with the real lexer)', () => {
  const lines = SAMPLE['docs/README.md'].split('\n');
  const blocks = mapBlocks(marked.lexer(lines.slice(3).join('\n')), 3);
  assert.ok(blocks.length > 5);
  for (const { token, start, end } of blocks) {
    const first = lines[start - 1];
    assert.ok(first.trim() !== '', `block ${token.type} starts on a blank line ${start}`);
    assert.equal(lines.slice(start - 1, end).join('\n').trim(), token.raw.trim(), `${token.type} ${start}-${end}`);
  }
});

test('mapBlocks skips blank space and works without an offset', () => {
  const blocks = mapBlocks(marked.lexer('a\n\n\n\nb'));
  assert.deepEqual(blocks.map(b => [b.start, b.end]), [[1, 1], [5, 5]]);
});
