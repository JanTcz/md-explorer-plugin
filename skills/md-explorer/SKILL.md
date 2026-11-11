---
name: md-explorer
description: Open the project's Markdown docs in the person's browser (md-explorer) and work from what they select there. Use when the person asks to open, browse or show the docs/wiki, says "this section", "here" or "what I have open" about the docs, pastes a reference like docs/a.md:12-40 (§ A > B), or asks you to point them to a place in the docs.
---

# md-explorer

A read-only browser reader for a folder of Markdown files, started from this plugin's own
files with `node` (no install, no npm). The person selects a block, a section or lines in the
page; that selection is what they mean by "this" or "here".

## Open it

The launcher is `bin/md-explorer.js` in this plugin: `${CLAUDE_PLUGIN_ROOT}/bin/md-explorer.js`
(from this skill's base directory, it is `../../bin/md-explorer.js`). Give it the docs folder
as a local path; the default is `docs/` of the current project, else the project folder.

1. Check whether it already runs for this folder: `curl -s localhost:4477/api/info`. It answers
   `{"name":"docs","refBase":"docs"}` when it is the same folder (the name is the folder's name);
   then just use that address. A busy port is replaced by a free one at start, so also look at
   the output of an earlier start if there was one.
2. Otherwise start it with the Bash tool in the background (`run_in_background: true`), so it
   stays up for the session:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/bin/md-explorer.js" docs --open
   ```

   The first output line is the address (`md-explorer: http://localhost:4477/ (/abs/path/docs)`);
   `--open` has already opened it in their default browser. Tell them the address.
3. It stops with the session's background task (or `pkill -f bin/md-explorer.js`).

Use `PORT` below for the port in the address.

## What they selected

```
curl -s localhost:PORT/api/selection
```

→ `{"selection":{"ref":"docs/a.md:12-40 (§ A > B)","path":"a.md","start":12,"end":40,"section":"A > B","text":"…"}}`,
or `{"selection":null}`. Call it when they point at something without naming it. `null`: ask
what they mean. `text` is the selected lines as they are on disk right now.

## Point them somewhere

```
curl -s -X POST localhost:PORT/api/navigate -H 'content-type: application/json' -d '{"ref":"docs/a.md:12-40"}'
```

Their tab scrolls there, highlights it and shows "Claude points to…". `ref` is `docs/a.md`,
`docs/a.md:12`, `docs/a.md:12-40` or `docs/a.md#heading-slug`. The answer has `"tabs": 0` when no
browser tab is open: say so and give them the address. Use this to show where something is
("the decision is in docs/arch.md:40-52") instead of only describing it.

## References

A reference is `path:start-end (§ Heading > Subheading)`, e.g.
`docs/architecture/overview.md:12-40 (§ Architecture > Layers)`. The path is relative to the
project, so `Read` takes it as is. The part in parentheses is only a label; the lines are exact
as of the moment they copied it. When a reference arrives in a message, read those lines
(`Read` with `offset` and `limit`, or use the quoted text if they copied it with text) and check
that the heading at the start line still matches the label: the file may have changed since.
When you quote a place in the docs back to them, write it in the same form.

## What not to do

The browser is read-only. Edit the Markdown files with your normal tools; the page reloads by itself.
