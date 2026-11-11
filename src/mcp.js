// An MCP server on stdio (JSON-RPC 2.0, one message per line), with no dependencies.
// It also runs the web server, so the browser app is there for as long as the session is.
// Three tools: where the browser is (explorer_url), what the person selected there
// (explorer_selection) and a way to point the person at a place in the docs (explorer_open).

import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { DocsError } from './docs.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'A read-only browser for the project\'s Markdown docs. The person may be looking at a page of it and mention "this section" ' +
  'or "here": call explorer_selection to see exactly what they have selected (path, lines, section, text). ' +
  'To show them a place in the docs, call explorer_open with a reference like docs/a.md:12-40 or docs/a.md#heading. ' +
  'explorer_url gives the address of the browser app, and opens it for them with open: true.';

function tool(name, description, properties = {}, required = [], readOnly = false) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true },
  };
}

export const TOOLS = [
  tool(
    'explorer_selection',
    'What the person has selected in the docs browser right now: a reference (path:lines and the section), and the selected text. ' +
      'Call it when they say "this", "here" or "the section I am looking at".',
    {},
    [],
    true,
  ),
  tool(
    'explorer_open',
    'Scroll the person\'s docs browser to a place and highlight it. `ref` is a reference: docs/a.md, docs/a.md:12, docs/a.md:12-40 or docs/a.md#section-slug.',
    { ref: { type: 'string', description: 'e.g. docs/architecture.md:12-40 or docs/architecture.md#decisions' } },
    ['ref'],
  ),
  tool(
    'explorer_url',
    'The address of the docs browser. With open: true it also opens it in the person\'s default browser.',
    { open: { type: 'boolean', description: 'Open it in the default browser' } },
  ),
];

/** Opens `url` in the default browser; resolves whether a launcher could be started. */
export function openBrowser(url, platform = process.platform, launch = spawn) {
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  return new Promise(resolve => {
    const child = launch(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const failure = message => ({ ...text(message), isError: true });

/** The tools, bound to a running server. `open` launches a browser (replaceable in tests). */
export function createTools(server, open = openBrowser) {
  return {
    async explorer_selection() {
      const selection = await server.selection();
      return selection
        ? text(selection)
        : text(`Nothing is selected in the docs browser (${server.url}${server.tabs() ? '' : ', no tab is open'}).`);
    },
    async explorer_open({ ref }) {
      const { target, tabs } = await server.navigate(ref);
      return tabs
        ? text({ shown: target.ref, tabs })
        : text({ shown: target.ref, tabs, note: `No browser tab is open. Open ${server.url} (explorer_url with open: true) and ask again.` });
    },
    async explorer_url({ open: isOpen } = {}) {
      const opened = isOpen ? await open(server.url) : false;
      return text({ url: server.url, root: server.root, tabs: server.tabs(), opened });
    },
  };
}

/** Answers one JSON-RPC message; `undefined` for a notification. */
export async function handle(message, tools) {
  const { id, method, params } = message;
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const error = (code, msg) => ({ jsonrpc: '2.0', id, error: { code, message: msg } });
  if (id === undefined) return undefined;
  switch (method) {
    case 'initialize': {
      const wanted = params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'md-explorer', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const run = tools[params?.name];
      if (!run || !Object.hasOwn(tools, params.name)) return error(-32602, `Unknown tool: ${params?.name}`);
      try {
        return ok(await run(params.arguments ?? {}));
      } catch (e) {
        if (e instanceof DocsError) return ok(failure(e.message));
        throw e;
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

/** Reads messages from `input` until it ends, writes answers to `output`. */
export async function serve(tools, input = process.stdin, output = process.stdout) {
  const rl = readline.createInterface({ input });
  const pending = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    pending.push(
      (async () => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        }
        let answer;
        try {
          answer = await handle(message, tools);
        } catch (e) {
          answer = { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } };
        }
        if (answer) output.write(JSON.stringify(answer) + '\n');
      })(),
    );
  }
  await Promise.all(pending);
}
