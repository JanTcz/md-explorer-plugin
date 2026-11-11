// md-explorer browser app: tree, rendered/source view, search, and the selection that
// becomes a reference for Claude. The libraries (marked, DOMPurify, highlight.js,
// MiniSearch) are loaded as globals by index.html.

import { excerpt, formatRef } from './shared/refs.js';
import { mapBlocks, frontMatterLines } from './shared/blocks.js';

const $ = sel => document.querySelector(sel);
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MD = /\.(md|markdown|mdx)$/i;

const state = {
  info: { name: '', refBase: '' },
  files: [],
  cur: null, // { path, text, sections, mtimeMs }
  blocks: [], // [{ el, start, end }] of the rendered view
  mode: store('mode') === 'source' ? 'source' : 'rendered',
  sel: null, // { start, end }
  anchor: null,
  filter: '',
  openDirs: new Set(),
};

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`md-explorer.${key}`);
    localStorage.setItem(`md-explorer.${key}`, value);
  } catch {
    return null; // storage blocked: the app works without remembering
  }
}

async function api(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

async function copy(text, message = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message);
}

// ---------------------------------------------------------------- routing

const hashFor = (path, range) =>
  '#' + path.split('/').map(encodeURIComponent).join('/') + (range ? `:${range.start}${range.end > range.start ? '-' + range.end : ''}` : '');

function parseHash() {
  const m = /^(.+?\.(?:md|markdown|mdx))(?::(\d+)(?:-(\d+))?)?$/i.exec(decodeURIComponent(location.hash.slice(1)));
  if (!m) return null;
  const start = m[2] ? Number(m[2]) : undefined;
  return { path: m[1], range: start ? { start, end: Math.max(start, Number(m[3] ?? start)) } : undefined };
}

async function nav(path, opts = {}) {
  history.pushState(null, '', hashFor(path, opts.select));
  await open(path, opts);
}

// ---------------------------------------------------------------- tree

function buildTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const dir of parts.slice(0, -1)) {
      if (!node.dirs.has(dir)) node.dirs.set(dir, { dirs: new Map(), files: [] });
      node = node.dirs.get(dir);
    }
    node.files.push({ name: parts.at(-1), path: f.path });
  }
  return root;
}

function renderTree() {
  const q = state.filter.trim().toLowerCase();
  const files = q ? state.files.filter(f => f.path.toLowerCase().includes(q)) : state.files;
  const el = $('#tree');
  if (!files.length) {
    el.innerHTML = `<div class="none">${state.files.length ? 'No file matches.' : 'No Markdown files here.'}</div>`;
    return;
  }
  const walk = (node, prefix) => {
    let html = '';
    for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))) {
      const dir = prefix + name;
      const isOpen = q || state.openDirs.has(dir);
      html += `<details data-dir="${esc(dir)}"${isOpen ? ' open' : ''}><summary>${esc(name)}</summary><div class="children">${walk(child, dir + '/')}</div></details>`;
    }
    for (const f of node.files) {
      const cls = state.cur?.path === f.path ? ' class="current"' : '';
      html += `<a href="${esc(hashFor(f.path))}" data-path="${esc(f.path)}"${cls} title="${esc(f.path)}">${esc(f.name.replace(MD, ''))}</a>`;
    }
    return html;
  };
  el.innerHTML = walk(buildTree(files), '');
}

function revealInTree(path) {
  const parts = path.split('/').slice(0, -1);
  parts.forEach((_, i) => state.openDirs.add(parts.slice(0, i + 1).join('/')));
  renderTree();
  $('#tree a.current')?.scrollIntoView({ block: 'nearest' });
}

$('#tree').addEventListener(
  'toggle',
  e => {
    const dir = e.target.dataset?.dir;
    if (dir === undefined) return;
    if (e.target.open) state.openDirs.add(dir);
    else state.openDirs.delete(dir);
  },
  true,
);
$('#tree').addEventListener('click', e => {
  const a = e.target.closest('a[data-path]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault();
  nav(a.dataset.path);
  if (matchMedia('(max-width: 720px)').matches) document.body.classList.add('no-sidebar');
});
$('#filter').addEventListener('input', e => {
  state.filter = e.target.value;
  renderTree();
});

// ---------------------------------------------------------------- document

const sectionAt = line => state.cur?.sections.findLast(s => s.start <= line);
const refPath = path => (state.info.refBase ? `${state.info.refBase}/${path}` : path);

function resolveLink(href) {
  const dir = state.cur.path.split('/').slice(0, -1);
  const parts = href.startsWith('/') ? [] : dir;
  const out = [...parts];
  for (const p of href.replace(/^\//, '').split('/')) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

function fixLinks(root) {
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    } else if (href.startsWith('#')) {
      a.dataset.slug = decodeURIComponent(href.slice(1));
    } else {
      const [file, frag] = href.split('#');
      let target;
      try {
        target = resolveLink(decodeURIComponent(file));
      } catch {
        continue;
      }
      if (MD.test(target)) {
        a.dataset.md = target;
        if (frag) a.dataset.slug = decodeURIComponent(frag);
        a.setAttribute('href', hashFor(target));
      }
    }
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    img.src = `/api/raw?path=${encodeURIComponent(resolveLink(decodeURIComponent(src.split('#')[0])))}`;
  }
}

marked.use({
  gfm: true,
  renderer: {
    code(code, info) {
      const lang = (info ?? '').split(/\s/)[0];
      const html = lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang }).value : esc(code);
      return `<pre><code class="hljs${lang ? ' language-' + esc(lang) : ''}">${html}</code></pre>`;
    },
  },
});

function renderDoc() {
  const doc = $('#doc');
  const { text, sections } = state.cur;
  doc.className = 'doc';
  doc.replaceChildren();
  state.blocks = [];
  const lines = text.split('\n');
  const fm = frontMatterLines(lines);

  if (state.mode === 'source') {
    doc.classList.add('src-wrap');
    const wrap = document.createElement('div');
    wrap.className = 'src';
    lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'srcline';
      row.innerHTML = `<button class="n" data-act="line" title="Select line (Shift+click for a range)">${i + 1}</button><span class="t"></span>`;
      row.lastChild.textContent = line;
      state.blocks.push({ el: row, start: i + 1, end: i + 1 });
      wrap.append(row);
    });
    doc.append(wrap);
  } else {
    if (fm) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = `<details><summary>front matter</summary><pre></pre></details>`;
      meta.querySelector('pre').textContent = lines.slice(0, fm).join('\n');
      doc.append(meta);
    }
    const tokens = marked.lexer(lines.slice(fm).join('\n'));
    for (const { token, start, end } of mapBlocks(tokens, fm)) {
      const el = document.createElement('section');
      el.className = 'blk';
      el.dataset.s = start;
      el.dataset.e = end;
      el.innerHTML = `<button class="ln" data-act="block" title="Select this block (Shift+click extends)">${start}</button>` + DOMPurify.sanitize(marked.parser([token]));
      if (token.type === 'heading') {
        const section = sections.find(s => s.start === start);
        const h = el.querySelector('h1,h2,h3,h4,h5,h6');
        if (section && h) {
          h.id = section.slug;
          h.insertAdjacentHTML('beforeend', `<button class="sec" data-act="section" title="Select this whole section and copy its reference">§</button>`);
        }
      }
      fixLinks(el);
      doc.append(el);
      state.blocks.push({ el, start, end });
    }
  }
  renderToc();
  applySelection({ sync: false });
}

function renderToc() {
  const items = state.cur.sections.filter(s => s.level >= 1 && s.level <= 3);
  $('#toc').innerHTML = items
    .map(s => `<a href="#" class="l${s.level}" data-line="${s.start}" title="${esc(s.title)}">${esc(s.title)}</a>`)
    .join('');
  updateToc();
}

function updateToc() {
  const top = $('#main').getBoundingClientRect().top + 40;
  let active;
  for (const s of state.cur?.sections ?? []) {
    const b = state.blocks.find(x => x.start >= s.start);
    if (b && b.el.getBoundingClientRect().top <= top) active = s.start;
  }
  for (const a of $('#toc').children) a.classList.toggle('active', Number(a.dataset.line) === active);
}

function renderCrumbs() {
  const parts = state.cur ? state.cur.path.split('/') : [];
  $('#crumbs').innerHTML = parts.map((p, i) => (i === parts.length - 1 ? `<b>${esc(p)}</b>` : `${esc(p)} / `)).join('');
  document.title = state.cur ? `${parts.at(-1)} — md-explorer` : 'md-explorer';
}

function scrollToLine(line, { flash = true } = {}) {
  const hit = state.blocks.find(b => b.start <= line && line <= b.end) ?? state.blocks.find(b => b.start >= line);
  if (!hit) return;
  hit.el.scrollIntoView({ block: 'start' });
  if (flash && !hit.el.classList.contains('sel')) {
    hit.el.classList.add('flash');
    setTimeout(() => hit.el.classList.remove('flash'), 2300);
  }
}

async function open(path, { select, line, slug, flash = true } = {}) {
  if (state.cur?.path !== path) {
    try {
      state.cur = await api(`/api/file?path=${encodeURIComponent(path)}`);
    } catch (e) {
      $('#doc').innerHTML = `<p class="empty error">${esc(e.message)}</p>`;
      state.cur = null;
      renderCrumbs();
      return;
    }
    state.sel = null;
    state.anchor = null;
    renderCrumbs();
    renderDoc();
    revealInTree(path);
    $('#main').scrollTop = 0;
  }
  if (slug) line = state.cur.sections.find(s => s.slug === slug)?.start ?? line;
  if (select) {
    state.sel = { ...select };
    state.anchor = select;
    applySelection();
    scrollToLine(select.start, { flash: false });
  } else if (line) {
    scrollToLine(line, { flash });
  }
}

// ---------------------------------------------------------------- selection and references

function selectionRef() {
  const { start, end } = state.sel;
  const section = sectionAt(start);
  return formatRef({ path: refPath(state.cur.path), start, end, breadcrumb: section?.level ? section.breadcrumb : [] });
}

let postTimer;
function applySelection({ sync = true } = {}) {
  const sel = state.sel;
  for (const b of state.blocks) b.el.classList.toggle('sel', !!sel && b.start <= sel.end && b.end >= sel.start);
  const bar = $('#selbar');
  bar.hidden = !sel;
  if (sel) $('#selref').textContent = selectionRef();
  if (!sync || !state.cur) return;
  history.replaceState(null, '', hashFor(state.cur.path, sel));
  clearTimeout(postTimer);
  postTimer = setTimeout(() => {
    const body = sel ? { path: state.cur.path, start: sel.start, end: sel.end } : { clear: true };
    api('/api/selection', body).catch(() => {});
  }, 200);
}

function pick(start, end, extend) {
  if (extend && state.anchor) {
    state.sel = { start: Math.min(state.anchor.start, start), end: Math.max(state.anchor.end, end) };
  } else if (state.sel && state.sel.start === start && state.sel.end === end) {
    state.sel = null; // the same click again lets go
    state.anchor = null;
  } else {
    state.sel = { start, end };
    state.anchor = { start, end };
  }
  applySelection();
}

function selectionText() {
  const { start, end } = state.sel;
  const body = excerpt(state.cur.text, start, end);
  const fence = '`'.repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map(m => m[0].length + 1)));
  return `${selectionRef()}\n\n${fence}md\n${body}\n${fence}`;
}

$('#doc').addEventListener('click', e => {
  const link = e.target.closest('a[data-md], a[data-slug]');
  if (link && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    const target = link.dataset.md ?? state.cur.path;
    nav(target, { slug: link.dataset.slug });
    return;
  }
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const row = act.closest('.blk, .srcline');
  const b = state.blocks.find(x => x.el === row);
  if (!b) return;
  if (act.dataset.act === 'section') {
    const section = state.cur.sections.find(s => s.start === b.start);
    state.sel = { start: section.start, end: section.treeEnd };
    state.anchor = state.sel;
    applySelection();
    copy(selectionRef(), 'Copied section reference');
  } else {
    pick(b.start, b.end, e.shiftKey);
  }
});

$('#toc').addEventListener('click', e => {
  const a = e.target.closest('a[data-line]');
  if (!a) return;
  e.preventDefault();
  scrollToLine(Number(a.dataset.line));
});
$('#main').addEventListener('scroll', () => requestAnimationFrame(updateToc), { passive: true });

$('#sel-copy').addEventListener('click', () => copy(selectionRef(), 'Copied reference'));
$('#sel-copy-text').addEventListener('click', () => copy(selectionText(), 'Copied reference with text'));
$('#sel-clear').addEventListener('click', clearSelection);
function clearSelection() {
  state.sel = null;
  state.anchor = null;
  applySelection();
}

// ---------------------------------------------------------------- view mode and chrome

function setMode(mode) {
  state.mode = mode;
  store('mode', mode);
  $('#view-rendered').classList.toggle('on', mode === 'rendered');
  $('#view-source').classList.toggle('on', mode === 'source');
  if (!state.cur) return;
  const top = state.sel?.start ?? state.blocks.find(b => b.el.getBoundingClientRect().bottom > $('#main').getBoundingClientRect().top + 8)?.start;
  renderDoc();
  if (top) scrollToLine(top, { flash: false });
}
$('#view-rendered').addEventListener('click', () => setMode('rendered'));
$('#view-source').addEventListener('click', () => setMode('source'));
$('#toggle-sidebar').addEventListener('click', toggleSidebar);
function toggleSidebar() {
  document.body.classList.toggle('no-sidebar');
  store('sidebar', document.body.classList.contains('no-sidebar') ? 'closed' : 'open');
}

// ---------------------------------------------------------------- search

let mini = null;
let isIndexStale = true;
let results = [];
let active = 0;

const fold = t => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

async function ensureIndex() {
  if (mini && !isIndexStale) return;
  const { docs } = await api('/api/index');
  mini = new MiniSearch({
    fields: ['title', 'crumb', 'text'],
    storeFields: ['path', 'title', 'breadcrumb', 'start', 'end', 'text'],
    processTerm: fold,
    searchOptions: { boost: { title: 3, crumb: 2 }, prefix: true, fuzzy: 0.2, combineWith: 'AND' },
  });
  mini.addAll(docs.map(d => ({ ...d, crumb: d.breadcrumb.join(' ') })));
  isIndexStale = false;
}

function snippet(text, terms) {
  const lines = text.split('\n').filter(l => l.trim());
  const hit = lines.find(l => terms.some(t => fold(l).includes(t))) ?? lines[0] ?? '';
  const i = Math.max(0, fold(hit).indexOf(terms.find(t => fold(hit).includes(t)) ?? '\0') - 30);
  const part = hit.slice(i, i + 140).trim();
  const re = terms.length ? new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi') : null;
  const html = esc(part);
  return re ? html.replace(re, '<mark>$1</mark>') : html;
}

async function runSearch() {
  const q = $('#q').value.trim();
  const list = $('#results');
  if (!q) {
    results = [];
    list.innerHTML = '<li class="none">Type to search titles and text of all documents.</li>';
    return;
  }
  await ensureIndex();
  const terms = q.split(/\s+/).map(fold);
  results = mini.search(q).slice(0, 30);
  active = 0;
  list.innerHTML = results.length
    ? results
        .map(
          (r, i) =>
            `<li data-i="${i}"${i === 0 ? ' class="on"' : ''}><div class="rt">${esc(r.breadcrumb.at(-1) ?? r.title)}</div>` +
            `<div class="rp">${esc(r.path)}:${r.start}${r.breadcrumb.length > 1 ? ' · ' + esc(r.breadcrumb.slice(0, -1).join(' > ')) : ''}</div>` +
            `<div class="rs">${snippet(r.text, terms)}</div></li>`,
        )
        .join('')
    : '<li class="none">No results.</li>';
}

function openPalette() {
  $('#palette').hidden = false;
  $('#q').focus();
  $('#q').select();
  runSearch();
}
function closePalette() {
  $('#palette').hidden = true;
}
function choose(i) {
  const r = results[i];
  if (!r) return;
  closePalette();
  nav(r.path, { line: r.start });
}
function moveActive(delta) {
  const items = [...$('#results').querySelectorAll('li[data-i]')];
  if (!items.length) return;
  items[active]?.classList.remove('on');
  active = (active + delta + items.length) % items.length;
  items[active].classList.add('on');
  items[active].scrollIntoView({ block: 'nearest' });
}

let searchTimer;
$('#q').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 80);
});
$('#q').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') (e.preventDefault(), moveActive(1));
  else if (e.key === 'ArrowUp') (e.preventDefault(), moveActive(-1));
  else if (e.key === 'Enter') choose(active);
});
$('#results').addEventListener('click', e => {
  const li = e.target.closest('li[data-i]');
  if (li) choose(Number(li.dataset.i));
});
$('#palette').addEventListener('mousedown', e => {
  if (e.target === $('#palette')) closePalette();
});
$('#open-search').addEventListener('click', openPalette);

document.addEventListener('keydown', e => {
  const typing = e.target.matches('input, textarea');
  if (e.key === 'Escape') {
    if (!$('#palette').hidden) closePalette();
    else if (typing) e.target.blur();
    else if (state.sel) clearSelection();
  } else if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
    e.preventDefault();
    openPalette();
  } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key.toLowerCase() === 'c' && state.sel) copy(e.shiftKey ? selectionText() : selectionRef(), e.shiftKey ? 'Copied reference with text' : 'Copied reference');
    else if (e.key === 's') setMode(state.mode === 'source' ? 'rendered' : 'source');
    else if (e.key === '[') toggleSidebar();
  }
});

// ---------------------------------------------------------------- live updates and startup

async function loadTree() {
  state.files = (await api('/api/tree')).files;
  renderTree();
}

async function reloadCurrent() {
  if (!state.cur) return;
  const path = state.cur.path;
  let fresh;
  try {
    fresh = await api(`/api/file?path=${encodeURIComponent(path)}`);
  } catch {
    $('#doc').innerHTML = `<p class="empty error">${esc(path)} was removed.</p>`;
    state.cur = null;
    return;
  }
  if (fresh.text === state.cur.text) return;
  const scroll = $('#main').scrollTop;
  state.cur = fresh;
  const last = fresh.text.split('\n').length;
  if (state.sel) state.sel = { start: Math.min(state.sel.start, last), end: Math.min(state.sel.end, last) };
  renderDoc();
  $('#main').scrollTop = scroll;
  toast('Reloaded: the file changed');
}

function listen() {
  const events = new EventSource('/api/events');
  events.addEventListener('changed', async () => {
    isIndexStale = true;
    await loadTree();
    await reloadCurrent();
    if (state.cur) revealInTree(state.cur.path);
  });
  events.addEventListener('navigate', e => {
    const t = JSON.parse(e.data);
    const range = t.start ? { start: t.start, end: t.end ?? t.start } : undefined;
    nav(t.path, range ? { select: range } : {});
    toast(`Claude points to ${t.path}${range ? ':' + range.start : ''}`);
  });
}

async function route() {
  const target = parseHash();
  if (target) return open(target.path, { select: target.range });
  const first = state.files.find(f => /^(readme|index)\.(md|markdown|mdx)$/i.test(f.path)) ?? state.files[0];
  if (first) return open(first.path);
  $('#doc').innerHTML = '<p class="empty">No Markdown files in this folder.</p>';
}

window.addEventListener('popstate', route);

async function start() {
  if (store('sidebar') === 'closed') document.body.classList.add('no-sidebar');
  $('#view-rendered').classList.toggle('on', state.mode === 'rendered');
  $('#view-source').classList.toggle('on', state.mode === 'source');
  try {
    state.info = await api('/api/info');
    $('#root-name').textContent = state.info.refBase || state.info.name;
    await loadTree();
  } catch (e) {
    $('#doc').innerHTML = `<p class="empty error">${esc(e.message)}</p>`;
    return;
  }
  await route();
  listen();
}
start();
