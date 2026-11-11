---
name: md-explorer
description: Work with the person's docs browser (md-explorer), a read-only web reader for the project's Markdown docs. Use when the person says "this section", "here", "what I have open" or "what I selected" about the docs, pastes a reference like docs/a.md:12-40 (§ A > B), asks you to show or point them to a place in the docs, or asks to open the docs.
---

# md-explorer

The person reads the project's Markdown docs (`docs/` by default) in a browser tab.
In the tab they can select a block, a section or a range of lines; that selection is
what they mean by "this" or "here".

## Tools

Use the `explorer_*` MCP tools:

- `explorer_selection`: what is selected right now: `ref`, `path`, `start`/`end` lines,
  `section` and the selected `text`. Call it when they point at something without naming it.
  `Nothing is selected`: ask what they mean, or offer to open the docs.
- `explorer_open {ref}`: scroll their browser to a place and highlight it. Use it to show
  them where something is ("the decision is in docs/arch.md:40-52") instead of only
  describing it. `tabs: 0` means no browser tab is open: say so, and offer `explorer_url`.
- `explorer_url {open}`: the address; `open: true` opens it in their browser.

## References

A reference is `path:start-end (§ Heading > Subheading)`, for example
`docs/architecture/overview.md:12-40 (§ Architecture > Layers)`. The path is relative to
the project. The part in parentheses is only a label; the lines are exact as of the
moment they copied it. When a reference arrives in a message, read those lines
(`Read` with `offset` and `limit`, or the quoted text if they copied it with text) and
check that the heading at the start line still matches the label: the file may have
changed since.

When you quote a place in the docs back to them, write it in the same form, so they can
paste it into the browser's address bar as `#path:start-end`.

## What not to do

The browser is read-only. Edit the Markdown files themselves with your normal tools;
the page reloads by itself when they change.
