/**
 * Server-rendered HTML for the public pages.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS RENDERED ON THE SERVER AND NOT IN A SINGLE-PAGE APP
 * ---------------------------------------------------------------------------
 * These pages ARE the SEO surface for all nine .pro sites. A crawler has to
 * read the results without running JavaScript, and a contestant on one bar of
 * signal in a parking lot has to read them on a page that is a few kilobytes
 * and no round trips.
 *
 * So: one HTML document, no client script, no webfont, no framework. The
 * heaviest thing on the page is the table.
 *
 * ---------------------------------------------------------------------------
 * ESCAPING
 * ---------------------------------------------------------------------------
 * Everything that came from the database goes through esc(). A contestant
 * called `<script>` is a contestant called `<script>`, and the interactive app
 * avoids the whole class by never using innerHTML — this file cannot, because
 * it emits markup, so the discipline is that no interpolation happens without
 * a call to esc() or a number that has been through Number().
 */

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** The only way a database value reaches the markup. */
export function esc(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

/** Integer cents to money. Never a float total. */
export function money(cents: unknown): string {
  const n = Math.round(Number(cents ?? 0));
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(
    abs % 100,
  ).padStart(2, '0')}`;
}

/** Decimal dollars, as stored on `results`. */
export function dollars(value: unknown): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return '';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function title(code: string): string {
  return code
    .replace(/_/g, ' ')
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  /** JSON-LD, already an object. Serialised safely below. */
  jsonLd?: Record<string, unknown>;
  /** Crawlers should not index a page that is mostly empty. */
  noindex?: boolean;
}

/**
 * JSON-LD has to be escaped differently from HTML text: the content of a
 * <script> element is not parsed for entities, so `&lt;` would be literal. The
 * only sequence that can break out is `</`, so that is what is neutralised.
 */
function jsonLdScript(data: Record<string, unknown>): string {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  return `<script type="application/ld+json">${json}</script>`;
}

const STYLE = `
:root{--bg:#fbfaf8;--surface:#fff;--line:#ddd8d0;--ink:#1a1815;--soft:#5d574e;--accent:#8a4b12}
@media(prefers-color-scheme:dark){:root{--bg:#14120f;--surface:#1e1b17;--line:#38332c;--ink:#f3efe8;--soft:#a99f92;--accent:#d9922f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{border-bottom:1px solid var(--line);background:var(--surface)}
header .in{max-width:960px;margin:0 auto;padding:14px 18px;display:flex;gap:14px;align-items:baseline}
a{color:var(--accent)}
.brand{font-weight:700;color:var(--ink);text-decoration:none}
main{max-width:960px;margin:0 auto;padding:22px 18px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.02em}
h2{font-size:20px;margin:32px 0 10px}
h3{font-size:16px;margin:20px 0 6px;color:var(--soft)}
.sub{color:var(--soft);margin:0 0 8px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;margin:6px 0 18px}
th{text-align:left;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--soft);border-bottom:2px solid var(--line);padding:6px 8px}
td{padding:9px 8px;border-bottom:1px solid var(--line)}
td.p{width:44px;font-weight:700}
td.r{text-align:right}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.list a{display:block;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--surface);text-decoration:none;color:inherit;margin:8px 0}
.list a:hover{border-color:var(--accent)}
.list strong{display:block}
.list span{color:var(--soft);font-size:14px}
.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;color:var(--soft)}
footer{max-width:960px;margin:0 auto;padding:0 18px 40px;color:var(--soft);font-size:14px}
`.trim();

/** The whole document. */
export function page(meta: PageMeta, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(meta.canonical)}">
${meta.noindex ? '<meta name="robots" content="noindex,follow">' : ''}
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(meta.canonical)}">
<meta name="twitter:card" content="summary">
<style>${STYLE}</style>
${meta.jsonLd ? jsonLdScript(meta.jsonLd) : ''}
</head>
<body>
<header><div class="in">
  <a class="brand" href="/results">RodeoApps</a>
  <span class="tag">Official results</span>
</div></header>
<main>
${body}
</main>
<footer>
  <p>Results are published by the producer that ran the rodeo. Placings appear
  here once they are official.</p>
</footer>
</body>
</html>`;
}

/** A row of results grouped under its event and round. */
export function resultTable(
  heading: string,
  rows: {
    place: number | null;
    first_name: string;
    last_name: string;
    contestant_id: string;
    aggregate_score: string | null;
    payout_amount: string;
  }[],
): string {
  const body = rows
    .map(
      (r) => `<tr>
<td class="p">${esc(r.place ?? '—')}</td>
<td><a href="/results/contestant/${esc(r.contestant_id)}">${esc(r.first_name)} ${esc(r.last_name)}</a></td>
<td>${esc(r.aggregate_score ?? '')}</td>
<td class="r">${esc(dollars(r.payout_amount))}</td>
</tr>`,
    )
    .join('\n');

  return `<h3>${esc(heading)}</h3>
<table>
<thead><tr><th>#</th><th>Contestant</th><th>Score</th><th class="r">Won</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
}
