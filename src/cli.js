// md-explorer [dir] [--port N] [--open]   serve the docs folder in the browser

import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer } from './server.js';
import { openBrowser } from './open.js';

export const DEFAULT_PORT = 4477;

const HELP = `md-explorer: read a folder of Markdown files in the browser

Usage:
  md-explorer [dir] [--port N] [--open]   serve dir (default: docs/ if it exists, else the current folder)

The docs folder can also be set with MD_EXPLORER_ROOT, the port with MD_EXPLORER_PORT (default ${DEFAULT_PORT}; a busy one is replaced by a free one).
The address is printed on the first line. The server listens on localhost only and never writes to the docs folder.
Stop it with Ctrl+C (or by killing the process).
`;

function parse(argv) {
  const out = { positional: [], open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice(7);
    else if (a === '--open') out.open = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
    else out.positional.push(a);
  }
  return out;
}

async function defaultRoot(cwd, given) {
  if (given) return path.resolve(cwd, given);
  const docs = path.join(cwd, 'docs');
  const isDir = await fs.stat(docs).then(s => s.isDirectory(), () => false);
  return isDir ? docs : cwd;
}

/* node:coverage disable */
const forever = () => new Promise(() => {}); // until the process is stopped; bin/ passes its own, for the signals
/* node:coverage enable */

/** Runs the command line; resolves to the exit code. `io` is replaceable in tests. */
export async function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, waitForExit = forever, open = openBrowser } = {}) {
  let args;
  try {
    args = parse(argv);
  } catch (e) {
    stderr.write(`${e.message}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    stdout.write(HELP);
    return 0;
  }
  const dir = args.positional[0] ?? env.MD_EXPLORER_ROOT;
  const rawPort = args.port ?? env.MD_EXPLORER_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    stderr.write(`Bad port: ${rawPort}\n`);
    return 2;
  }
  const root = await defaultRoot(cwd, dir);
  const isDir = await fs.stat(root).then(s => s.isDirectory(), () => false);
  if (!isDir) {
    stderr.write(`Not a folder: ${root}\n`);
    return 1;
  }
  const server = await startServer({ root, cwd, port, fallback: true });
  stdout.write(`md-explorer: ${server.url} (${root})\n`);
  if (args.open) await open(server.url);
  await waitForExit();
  await server.close();
  return 0;
}
