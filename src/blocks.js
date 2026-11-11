// Maps the top-level tokens of a Markdown lexer (marked) to the source lines they came from,
// so the browser can tie every rendered block to `start-end` lines of the file.
// Pure, shared with the browser as /shared/blocks.js.

/** Number of lines of a leading `---` front matter block (with its fences), else 0. */
export function frontMatterLines(lines) {
  if (lines[0]?.trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)\s*$/.test(lines[i])) return i + 1;
  return 0;
}

const count = (s, ch) => s.split(ch).length - 1;

/**
 * `tokens` are `marked.lexer(body)` of the text after `offset` lines (the front matter).
 * Returns `{ token, start, end }` for every token that draws something (blank space draws nothing);
 * lines are 1-based and inclusive, `end` the last non-blank line of the block.
 */
export function mapBlocks(tokens, offset = 0) {
  const blocks = [];
  let line = offset;
  for (const token of tokens) {
    const raw = token.raw;
    if (token.type !== 'space') {
      const visible = raw.replace(/\s+$/, '');
      blocks.push({ token, start: line + 1, end: line + 1 + count(visible, '\n') });
    }
    line += count(raw, '\n');
  }
  return blocks;
}
