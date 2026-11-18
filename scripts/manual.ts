/**
 * Reads docs/MANUAL.md. Two jobs: list its fenced code blocks, which test/manual.test.ts builds, and
 * turn the whole file into the page the site serves as manual.html.
 *
 * The renderer knows only the Markdown that the manual uses: headings, paragraphs, single-level
 * bullet and numbered lists, tables, fenced code, `code`, **bold** and [links](url). Anything else
 * throws, so a construct that would render wrongly is found by the tests and not by a reader.
 */

export interface CodeBlock {
  /** The first word after the opening fence: scad, text. */
  language: string;
  /** The other words: `key=value` gives a value, a bare word gives true. */
  attributes: Map<string, string | true>;
  code: string;
  /** Line of the opening fence, from 1. */
  line: number;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

const fence = /^```(.*)$/;

/** Every fenced code block of the manual, in order. */
export function codeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.split('\n');
  const blocks: CodeBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = fence.exec(lines[i]);
    if (!open) continue;
    const [language = '', ...words] = open[1].trim().split(/\s+/).filter(Boolean);
    const attributes = new Map<string, string | true>();
    for (const word of words) {
      const [key, ...value] = word.split('=');
      attributes.set(key, value.length ? value.join('=') : true);
    }
    const start = i;
    const code: string[] = [];
    for (i++; i < lines.length && lines[i] !== '```'; i++) code.push(lines[i]);
    if (i >= lines.length) throw new Error(`The code block that opens on line ${start + 1} of the manual is never closed.`);
    blocks.push({ language, attributes, code: code.join('\n'), line: start + 1 });
  }
  return blocks;
}

const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (character) => escapes[character]);

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Inline Markdown. Code spans are lifted out first and put back last, so **bold** can contain code and nothing inside code is changed. */
export function inline(text: string) {
  const codes: string[] = [];
  const lifted = text.replace(/`([^`]+)`/g, (_, code: string) => `\u0000${codes.push(`<code>${escapeHtml(code)}</code>`) - 1}\u0000`);
  return escapeHtml(lifted)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)]);
}

/** The cells of one table row. A pipe inside a code span does not split a cell. */
export function cells(row: string) {
  const result: string[] = [];
  let current = '';
  let code = false;
  for (const character of row.trim().replace(/^\|/, '').replace(/\|$/, '')) {
    if (character === '`') code = !code;
    if (character === '|' && !code) {
      result.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  result.push(current.trim());
  return result;
}

const separator = /^\|(\s*:?-+:?\s*\|)+\s*$/;
const bullet = /^- /;
const numbered = /^\d+\. /;

function startsBlock(line: string) {
  return !line.trim() || fence.test(line) || /^#{1,3} /.test(line) || line.startsWith('|') || bullet.test(line) || numbered.test(line);
}

export function renderBody(markdown: string) {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const headings: Heading[] = [];
  const fail = (i: number, why: string): never => {
    throw new Error(`Line ${i + 1} of the manual uses ${why}, which the manual renderer does not draw: ${lines[i]}`);
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const open = fence.exec(line);
    if (open) {
      const language = open[1].trim().split(/\s+/)[0] || 'text';
      const code: string[] = [];
      for (i++; i < lines.length && lines[i] !== '```'; i++) code.push(lines[i]);
      if (i >= lines.length) fail(i - 1, 'a code block that is never closed');
      i++;
      out.push(`<pre><code class="language-${escapeHtml(language)}">${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      const [, marks, text] = heading;
      const id = slug(text);
      headings.push({ level: marks.length, text, id });
      out.push(`<h${marks.length} id="${id}">${inline(text)}</h${marks.length}>`);
      i++;
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      if (rows.length < 2 || !separator.test(rows[1])) fail(i - rows.length, 'a table with no header separator');
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      body.forEach((row, r) => { if (row.length !== head.length) fail(i - rows.length + 2 + r, `a table row with ${row.length} cells instead of ${head.length}`); });
      out.push(`<div class="table"><table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (bullet.test(line) || numbered.test(line)) {
      const kind = bullet.test(line) ? bullet : numbered;
      const items: string[] = [];
      while (i < lines.length && kind.test(lines[i])) items.push(lines[i++].replace(kind, ''));
      if (i < lines.length && /^\s/.test(lines[i]) && lines[i].trim()) fail(i, 'a list item that continues or nests on the next line');
      const tag = kind === bullet ? 'ul' : 'ol';
      out.push(`<${tag}>${items.map((item) => `<li>${inline(item)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^(>|!\[|\s|<)/.test(line)) fail(i, 'a quote, an image, HTML or an indented line');
    const paragraph: string[] = [];
    while (i < lines.length && !startsBlock(lines[i])) {
      if (/^(>|!\[|\s|<)/.test(lines[i])) fail(i, 'a quote, an image, HTML or an indented line');
      paragraph.push(lines[i++]);
    }
    out.push(`<p>${inline(paragraph.join(' '))}</p>`);
  }
  return { html: out.join('\n'), headings };
}

const style = `
:root { color: #25323a; background: #f1f0eb; font-family: 'Geist Variable', Geist, system-ui, sans-serif; line-height: 1.6; }
* { box-sizing: border-box; }
body { margin: 0; }
.top { padding: 14px 24px; border-bottom: 1px solid #dfddd3; background: #fcfbf7; font-size: 14px; }
a { color: #2f6683; }
main { max-width: 860px; margin: 0 auto; padding: 8px 24px 80px; }
h1 { font-size: 30px; line-height: 1.2; margin: 28px 0 12px; }
h2 { font-size: 22px; margin: 44px 0 10px; padding-top: 18px; border-top: 1px solid #dfddd3; }
h3 { font-size: 17px; margin: 28px 0 6px; }
p, ul, ol { margin: 10px 0; }
li { margin: 4px 0; }
code { font-family: 'IBM Plex Mono', ui-monospace, Consolas, monospace; font-size: 0.9em; background: #e9e7de; padding: 1px 4px; border-radius: 3px; }
pre { margin: 12px 0; padding: 12px 14px; overflow-x: auto; background: #fcfbf7; border: 1px solid #dfddd3; border-radius: 6px; line-height: 1.5; }
pre code { padding: 0; background: none; font-size: 13px; }
.table { overflow-x: auto; margin: 12px 0; }
table { border-collapse: collapse; font-size: 14px; min-width: 60%; }
th, td { text-align: left; vertical-align: top; padding: 6px 12px; border: 1px solid #dfddd3; }
th { background: #e9e7de; }
nav.toc { margin: 16px 0 0; padding: 12px 18px; background: #fcfbf7; border: 1px solid #dfddd3; border-radius: 6px; }
nav.toc ol { margin: 0; padding-left: 20px; columns: 2; }
@media (max-width: 620px) { nav.toc ol { columns: 1; } main { padding: 8px 16px 60px; } }
@media print {
  :root { background: #fff; }
  .top, nav.toc { display: none; }
  h2.cheat { break-before: page; border-top: 0; margin-top: 0; }
  pre, tr { break-inside: avoid; }
}
`;

/** The page: the manual with a contents list after its first paragraph and a link back to the editor. */
export function renderManual(markdown: string) {
  const { html, headings } = renderBody(markdown);
  const title = headings.find((heading) => heading.level === 1)?.text ?? 'Manual';
  const toc = `<nav class="toc" aria-label="Contents"><ol>${headings.filter((heading) => heading.level === 2).map((heading) => `<li><a href="#${heading.id}">${escapeHtml(heading.text.replace(/^\d+\.\s*/, ''))}</a></li>`).join('')}</ol></nav>`;
  const marked = html
    .replace(/<h2 id="([^"]*cheat-sheet)"/, '<h2 class="cheat" id="$1"')
    // The contents go in just before the first section.
    .replace(/<h2 /, `${toc}\n<h2 `);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23f4c875'/%3E%3Cpath d='M16 7l8 4.5v9L16 25l-8-4.5v-9z M8 11.5l8 4.5 8-4.5 M16 16v9' fill='none' stroke='%233f311e' stroke-width='1.8' stroke-linejoin='round'/%3E%3C/svg%3E" />
<style>${style}</style>
</head>
<body>
<header class="top"><a href="./">&larr; Back to Partscript CAD</a></header>
<main>
${marked}
</main>
</body>
</html>
`;
}
