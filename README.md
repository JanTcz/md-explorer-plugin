# md-explorer

[![test](https://github.com/JanTcz/md-explorer-plugin/actions/workflows/test.yml/badge.svg)](https://github.com/JanTcz/md-explorer-plugin/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Read a folder of Markdown files in the browser, and point Claude at exactly the
part you mean.**

A project's `docs/` is a wiki of folders and `.md` files. md-explorer shows it as one:
a file tree on the left, the page in the middle, the outline on the right, search across
everything. And when you want to talk to Claude about *this* section, you select it and
paste a precise reference: path, section and lines.

```
docs/architecture/overview.md:12-40 (§ Architecture > Layers)
```

It is a Claude Code plugin made of plain JavaScript and HTML: no npm package, no install
step, no build. Claude starts it with `node` from the plugin's own folder, gives it a local
path and opens your browser. It is read-only (it never writes to your docs), listens on
`localhost` only, and needs Node 20+ and a browser.

## Features

- **Tree, outline, search.** Folders in a sidebar, the headings of the page on the right
  (the current one follows your scroll), and a search palette (`/` or `Ctrl/⌘+K`) over every
  heading and body of every file. It ignores diacritics (`rozhodnuti` finds `rozhodnutí`),
  matches prefixes and tolerates typos.
- **Rendered and source view** (`s` switches). GitHub-flavoured Markdown, highlighted code,
  tables, front matter folded away, links between documents that work, images next to the docs.
- **A reference to anything.**
  - Hover a block and click its line number to select it; <kbd>Shift</kbd>+click extends the
    range. In the *Source* view every line is selectable.
  - Click `§` next to a heading to select the **whole section**, subsections included, and copy
    its reference.
  - **Copy ref** (`c`) copies the reference; **Copy with text** (`Shift+C`) adds the selected
    text in a fenced block.
  - The selection is in the address bar too (`#docs/a.md:12-40`), so a link to the page
    restores it.
- **Live.** Save a file and the page reloads where you were; new files appear in the tree.
- **Claude sees it.** Claude can read what you have selected and can open a place in your
  browser for you.

## Install

```
/plugin install md-explorer --marketplace JanTcz/marketplace
```

Then ask Claude to open the docs, or run `/md-explorer:open [folder]`. Claude runs

```
node "${CLAUDE_PLUGIN_ROOT}/bin/md-explorer.js" docs --open
```

in the background, tells you the address (`http://localhost:4477/`; a busy port is replaced
by a free one) and your browser opens. From then on:

| You say | Claude does |
| --- | --- |
| "Explain this section" (with a selection in the browser) | `GET /api/selection`: gets the path, lines, section and the text, no pasting needed |
| pastes `docs/a.md:12-40 (§ A > B)` | reads exactly those lines and checks the heading still matches |
| "Where is the retry policy described?" | answers and `POST /api/navigate`s there: your tab scrolls to the place and highlights it |

The skill (`skills/md-explorer/SKILL.md`) tells Claude how; there is no MCP server and no
process running unless you asked for the docs.

## Without Claude

```
git clone https://github.com/JanTcz/md-explorer-plugin
node md-explorer-plugin/bin/md-explorer.js path/to/wiki --port 8080 --open
```

The docs folder is the argument, else `MD_EXPLORER_ROOT`, else `docs/` if the current folder
has one, else the current folder. The port is `--port`, else `MD_EXPLORER_PORT`, else 4477.

## The HTTP API

All on `localhost`, JSON. What Claude uses:

| | |
| --- | --- |
| `GET /api/selection` | `{ selection: { ref, path, start, end, section, text } }` or `{ selection: null }` |
| `POST /api/navigate {ref}` | scroll every open tab to `ref`; `{ target, tabs }` (`tabs: 0`: no tab is open) |
| `GET /api/info` | `{ name, refBase }`: which folder this is |

and what the page uses: `/api/tree`, `/api/file?path=`, `/api/index`, `/api/raw?path=`, `/api/events` (SSE).

## The reference format

| Meaning | Reference |
| --- | --- |
| a file | `docs/a.md` |
| a line | `docs/a.md:12` |
| a range | `docs/a.md:12-40` |
| a section (label only; the lines are what counts) | `docs/a.md:12-40 (§ Architecture > Layers)` |
| a section by its anchor (accepted by `/api/navigate`) | `docs/a.md#layers` |

Paths are relative to the project, so they are the paths Claude's `Read` takes. Lines are
as of the moment of copying: if the file changed since, the `§` label lets Claude notice.

## Keys

| Key | |
| --- | --- |
| `/` or `Ctrl/⌘+K` | search |
| `c` / `Shift+C` | copy the reference / with the text |
| `s` | rendered ⇄ source |
| `[` | hide or show the sidebar |
| `Esc` | close search, clear the selection |

## Safety

The server binds to `127.0.0.1`, refuses requests whose `Host` or `Origin` is not itself
(DNS rebinding, other websites), accepts writes only as JSON, serves nothing outside the docs
folder (symbolic links are resolved first) and from there only Markdown and images. The page
is sanitized with DOMPurify and runs under a strict Content-Security-Policy.

## Develop

```
npm test                          # node:test, 100 % of src/ covered (no dependencies to install)
node bin/md-explorer.js docs
claude --plugin-dir .             # the plugin from this checkout
```

```
.claude-plugin/ plugin.json         skills/, commands/   what Claude reads
bin/md-explorer.js                  the launcher
src/docs.js     scan folder, sections, safe path resolution
src/refs.js     the reference format      ┐ pure: the browser imports these two
src/blocks.js   lexer tokens → line ranges┘ from the server as /shared/*.js
src/server.js   HTTP API, events, selection      src/cli.js, src/open.js   command line, browser launch
web/            the browser app (no build step); web/vendor/ third-party libraries, see its README
```

## License

MIT. Third-party libraries in `web/vendor/` keep their own licenses (listed in its README).
