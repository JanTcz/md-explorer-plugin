// The local web server: the browser app (web/), a small JSON API over the docs folder,
// a Server-Sent Events stream (file changes, "look here" from Claude via POST /api/navigate) and the selection
// the person made in the browser, which Claude reads back over HTTP (GET /api/selection).
// Bound to 127.0.0.1 only, read-only on the docs folder, no dependencies.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DocsError, excerpt, formatRef, parseRef, readDoc, resolveInside, scan } from './docs.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(SRC, '..', 'web');
// Pure modules the browser app imports from the server's own src/ (one copy of the reference format).
const SHARED = new Set(['refs.js', 'blocks.js']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};
// What /api/raw hands out from the docs folder (images next to the Markdown), nothing else.
const RAW = new Set(['.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp']);

const CSP =
  "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";

const toPosix = p => p.split(path.sep).join('/');

/**
 * Starts the server. `root` is the docs folder, `cwd` the project it belongs to (references are
 * relative to it, so Claude can open them). With `fallback`, a busy `port` is replaced by a free one; `pingMs` is the keep-alive of event streams. Resolves to `{ url, port, close, navigate, selection }`; `navigate` is also `POST /api/navigate {ref}`.
 */
export async function startServer({ root, cwd = process.cwd(), port = 0, host = '127.0.0.1', fallback = false, pingMs = 25_000 }) {
  root = await fs.realpath(path.resolve(root));
  const refBase = toPosix(path.relative(await fs.realpath(cwd), root));
  const clients = new Set();
  let selection;
  let hostHeaders;

  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const fail = (res, status, message) => send(res, status, { error: message });

  const broadcast = (event, data) => {
    for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Where a reference points, in the docs folder's own paths: `docs/a.md:3` (project-relative) or `a.md:3`.
  async function locate(refText) {
    const ref = parseRef(refText);
    if (!ref) throw new DocsError(`Not a reference to a Markdown file: ${refText}`);
    const candidates = [path.resolve(cwd, ref.path), path.resolve(root, ref.path)];
    for (const full of candidates) {
      const rel = path.relative(root, full);
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      try {
        const doc = await readDoc(root, toPosix(rel));
        let { start, end } = ref;
        if (ref.slug) {
          const s = doc.sections.find(x => x.slug === ref.slug);
          if (!s) throw new DocsError(`No section #${ref.slug} in ${doc.path}`);
          ({ start, end } = s);
        }
        return { path: doc.path, start, end, doc };
      } catch (e) {
        if (!(e instanceof DocsError) || /^No section/.test(e.message)) throw e;
      }
    }
    throw new DocsError(`Not found in the docs folder: ${ref.path}`);
  }

  async function currentSelection() {
    if (!selection) return null;
    try {
      const doc = await readDoc(root, selection.path);
      const text = excerpt(doc.text, selection.start, selection.end);
      const section = doc.sections.findLast(s => s.start <= selection.start);
      const breadcrumb = section?.level ? section.breadcrumb : [];
      const ref = formatRef({ ...selection, path: refBase ? `${refBase}/${selection.path}` : selection.path, breadcrumb });
      return { ...selection, section: breadcrumb.join(' > ') || undefined, ref, text };
    } catch {
      return null; // the file is gone since
    }
  }

  /** Tells every open browser tab to scroll to a reference; resolves to `{ target, tabs }`. */
  async function navigate(refText) {
    const { doc, ...target } = await locate(refText);
    broadcast('navigate', target);
    return { target: { ...target, ref: formatRef({ ...target, path: refBase ? `${refBase}/${target.path}` : target.path }) }, tabs: clients.size };
  }

  const readBody = req =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', c => {
        size += c.length;
        if (size > 64 * 1024) reject(new DocsError('Body too large'));
        else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch {
          reject(new DocsError('Invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  async function api(req, res, url) {
    const q = url.searchParams;
    if (req.method === 'GET') {
      switch (url.pathname) {
        case '/api/info':
          return send(res, 200, { name: path.basename(root), refBase });
        case '/api/tree':
          return send(res, 200, { files: await scan(root) });
        case '/api/file':
          return send(res, 200, await readDoc(root, q.get('path')));
        case '/api/index': {
          // Every section with its text: what the browser's search is built from.
          const docs = [];
          for (const f of await scan(root)) {
            try {
              const doc = await readDoc(root, f.path);
              const lines = doc.text.split('\n');
              for (const s of doc.sections) {
                docs.push({
                  id: `${f.path}:${s.start}`,
                  path: f.path,
                  title: s.title || f.path,
                  breadcrumb: s.breadcrumb,
                  start: s.start,
                  end: s.end,
                  text: lines.slice(s.start, s.end).join('\n'),
                });
              }
            } catch {
              // unreadable or too large: not searchable, still in the tree
            }
          }
          return send(res, 200, { docs });
        }
        case '/api/raw': {
          const full = await resolveInside(root, q.get('path'), { markdownOnly: false });
          const ext = path.extname(full).toLowerCase();
          if (!RAW.has(ext)) return fail(res, 415, `Not served: ${ext || 'no extension'}`);
          return send(res, 200, await fs.readFile(full), MIME[ext], { 'content-security-policy': 'sandbox' });
        }
        case '/api/selection':
          return send(res, 200, { selection: await currentSelection() });
        case '/api/events': {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          clients.add(res);
          req.on('close', () => clients.delete(res));
          return;
        }
      }
    } else if (req.method === 'POST') {
      // JSON only: a cross-site form cannot send this, a cross-site script is stopped by the Origin check.
      if (!/^application\/json/.test(req.headers['content-type'] ?? '')) return fail(res, 415, 'Send application/json');
      const body = await readBody(req);
      if (url.pathname === '/api/navigate') return send(res, 200, await navigate(body.ref));
      if (url.pathname === '/api/selection') {
        if (body.clear) selection = undefined;
        else {
          const file = await readDoc(root, body.path);
          const start = Number(body.start);
          const end = Number(body.end ?? body.start);
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) throw new DocsError('Bad line range');
          const last = file.text.split('\n').length;
          selection = { path: file.path, start: Math.min(start, last), end: Math.min(end, last) };
        }
        return send(res, 200, { selection: await currentSelection() });
      }
    }
    return fail(res, 404, 'Not found');
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const shared = rel.startsWith('shared/') && SHARED.has(rel.slice(7));
    const full = shared ? path.join(SRC, rel.slice(7)) : path.resolve(WEB, rel);
    if (!shared && !full.startsWith(WEB + path.sep)) return fail(res, 404, 'Not found');
    try {
      const body = await fs.readFile(full);
      return send(res, 200, body, MIME[path.extname(full)] ?? 'application/octet-stream', { 'content-security-policy': CSP });
    } catch {
      return fail(res, 404, 'Not found');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      // DNS rebinding: a page on another name that resolves to 127.0.0.1 must not reach the API.
      if (!hostHeaders.has(req.headers.host)) return fail(res, 403, 'Bad Host header');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}`) return fail(res, 403, 'Bad Origin');
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
      return await serveStatic(res, url.pathname);
    } catch (e) {
      if (e instanceof DocsError) return fail(res, 400, e.message);
      return fail(res, 500, 'Internal error');
    }
  });

  let timer;
  let watcher;
  try {
    watcher = watch(root, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => broadcast('changed', {}), 150);
    });
    // Live reload is a convenience: a platform that cannot watch recursively, or a watch that dies, goes without it.
    /* node:coverage disable */
    watcher.on('error', () => {});
  } catch {
    watcher = undefined;
  }
  /* node:coverage enable */
  const keepAlive = setInterval(() => broadcast('ping', {}), pingMs);
  keepAlive.unref();

  const listen = p =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    try {
      await listen(port);
    } catch (e) {
      if (!(fallback && port !== 0 && e.code === 'EADDRINUSE')) throw e;
      await listen(0);
    }
  } catch (e) {
    clearTimeout(timer);
    clearInterval(keepAlive);
    watcher?.close(); // a server that never started must not keep the process alive
    throw e;
  }
  const { port: actual } = server.address();
  hostHeaders = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);

  return {
    url: `http://localhost:${actual}/`,
    port: actual,
    root,
    refBase,
    navigate,
    selection: currentSelection,
    tabs: () => clients.size,
    close() {
      clearTimeout(timer);
      clearInterval(keepAlive);
      watcher?.close();
      for (const res of clients) res.end();
      clients.clear();
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    },
  };
}
