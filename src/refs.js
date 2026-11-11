// References into the docs ("docs/a.md:12-40 (§ A > B)"): written and read by the browser
// app and the server alike. Pure functions, no Node and no DOM, so the
// browser loads this very file (the server serves it as /shared/refs.js).

/**
 * A reference Claude can act on: `docs/a.md`, `docs/a.md:12`, `docs/a.md:12-40`,
 * with the section's breadcrumb when the whole block is meant: `docs/a.md:12-40 (§ A > B)`.
 */
export function formatRef({ path: file, start, end, breadcrumb }) {
  let ref = file;
  if (start) ref += end && end !== start ? `:${start}-${end}` : `:${start}`;
  if (breadcrumb?.length) ref += ` (§ ${breadcrumb.join(' > ')})`;
  return ref;
}

/** The inverse of `formatRef`; also takes `file#slug` and the `@file` form. `undefined` if it is none of them. */
export function parseRef(text) {
  const m = /^@?(.+?\.(?:md|markdown|mdx))(?:#([^\s:]+)|:(\d+)(?:-(\d+))?)?(?:\s+\(§.*\))?$/i.exec(String(text).trim());
  if (!m) return undefined;
  const start = m[3] ? Number(m[3]) : undefined;
  const end = m[4] ? Number(m[4]) : start;
  return { path: m[1], slug: m[2], start, end };
}

/** The text of lines `start..end` (1-based, inclusive) of `text`. */
export function excerpt(text, start, end = start) {
  const lines = text.split('\n');
  const a = Math.max(1, start);
  return lines.slice(a - 1, Math.min(lines.length, Math.max(a, end))).join('\n');
}
