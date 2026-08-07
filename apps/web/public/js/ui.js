/**
 * DOM helpers.
 *
 * `h()` builds elements; `text()` is the only way strings reach the page.
 * There is no innerHTML anywhere in this app, which means a contestant called
 * `<script>` is a contestant called `<script>` and not an incident.
 */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    f.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return f;
};

/** Integer cents to money. Never Number.toFixed on a float total. */
export function money(cents, currency = '$') {
  const n = Number(cents ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${currency}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

export function dateRange(start, end) {
  if (!start) return '';
  if (!end || start === end) return start;
  return `${start} → ${end}`;
}

/** "3h 12m" — how long the secretary has, in the units she thinks in. */
export function duration(ms) {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function toast(message, bad = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = bad ? 'toast bad' : 'toast';
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, bad ? 6000 : 3000);
}

export function crumbs(...parts) {
  const nav = document.getElementById('crumbs');
  nav.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) nav.append(h('span', { class: 'sep' }, '/'));
    nav.append(
      part.href
        ? h('a', { href: part.href }, part.label)
        : h('span', { class: 'now' }, part.label),
    );
  });
}

export function render(node) {
  const view = document.getElementById('view');
  view.replaceChildren(node);
  window.scrollTo(0, 0);
}

export function showPrint(handler) {
  const btn = document.getElementById('printBtn');
  btn.hidden = !handler;
  btn.onclick = handler ?? null;
}

/** A labelled field. */
export function field(label, control, hint) {
  return h('label', {}, label, hint ? h('span', { class: 'hint' }, hint) : null, control);
}

export function select(name, options, value, onChange) {
  return h(
    'select',
    { name, ...(onChange ? { onchange: onChange } : {}) },
    options.map((o) =>
      h('option', { value: o.value, selected: o.value === value ? true : null }, o.label),
    ),
  );
}
