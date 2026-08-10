/**
 * Render the views against a stub DOM.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * This app has no bundler, no dependencies and no build step, which is a
 * deliberate choice and a good one — but it meant nothing had ever rendered a
 * view, and there is no type checker over untyped browser JavaScript to notice
 * a mistake either. `node --check` parses a file; it does not run it.
 *
 * The gap that proved it: `api.request()` returns `payload.data`, not the whole
 * response envelope, so three screens read their counts off a `meta` object
 * that was always `{}`. Live bookings, amount outstanding, contestants missing
 * a release, the reporting threshold — every one of them silently blank, on
 * screens that looked perfectly fine in review. Delta D46.
 *
 * So the assertions here are about NUMBERS AND WORDS ON THE PAGE, not about
 * functions being called. A view that renders "0 live" when two bookings are
 * live has failed, and only a test that reads the rendered text can say so.
 *
 * ---------------------------------------------------------------------------
 * THE STUB
 * ---------------------------------------------------------------------------
 * Not a browser and not jsdom — this package has no dependencies and is not
 * about to gain one for a test. It is the smallest `document` that `h()` can
 * build against: createElement, createTextNode, append, replaceChildren, and
 * a getElementById that returns the same element twice so `render()` writes
 * somewhere readable.
 *
 *     node --test "test/*.test.mjs"
 */

const listeners = new Map();
function makeEl(tag) {
  const el = {
    tagName: tag.toUpperCase(), children: [], attrs: {}, dataset: {},
    className: '', value: '', style: {}, textContent: '',
    append(...cs) { for (const c of cs) { this.children.push(c); } },
    replaceChildren(...cs) { this.children = cs; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(k, f) { listeners.set(`${tag}:${k}`, f); },
    querySelector() { return null; },
    remove() {},
  };
  return el;
}
// Singleton elements by id, so render() writes somewhere we can read back.
const byId = new Map();
globalThis.document = {
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, text: String(t) }),
  createDocumentFragment: () => makeEl('fragment'),
  getElementById: (id) => {
    if (!byId.has(id)) byId.set(id, makeEl('div'));
    return byId.get(id);
  },
  querySelector: () => makeEl('div'),
  body: makeEl('body'),
};
globalThis.Node = class {};
globalThis.window = { print() {}, addEventListener() {}, scrollTo() {}, location: { hash: '' } };
globalThis.location = globalThis.window.location;
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.prompt = () => null;
globalThis.confirm = () => false;
globalThis.alert = () => {};

// h() checks `child instanceof Node`; our stubs are plain objects, so make the
// check pass for anything object-shaped with a tagName or nodeType.
Object.defineProperty(globalThis.Node, Symbol.hasInstance, {
  value: (x) => !!x && typeof x === 'object' && ('tagName' in x || 'nodeType' in x),
});

const W = new URL('../public/js', import.meta.url).href;
const ui = await import(`${W}/ui.js`);
const apiMod = await import(`${W}/api.js`);

// Count what was rendered by walking the tree h() built.
function countText(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.nodeType === 3) acc.push(node.text);
  for (const c of node.children ?? []) countText(c, acc);
  return acc;
}

const rodeo = {
  id: 'r1', name: 'Smoke Rodeo', slug: 'smoke',
  start_date: '2026-09-10', end_date: '2026-09-12',
  events: [], sanctioned_by: [],
};

const stub = {
  rodeo: async () => rodeo,
  resources: async () => [],
  availability: async () => ([
    { id: 's1', name: 'Barn 1', resource_type: 'stall', price_cents: 3500,
      price_unit: 'per_night', capacity: 1, remaining: 1, taken: 0 },
    { id: 'c1', name: 'North field', resource_type: 'camping', price_cents: 2000,
      price_unit: 'per_stay', capacity: 20, remaining: 0, taken: 20 },
  ]),
  bookings: async () => ([
    { id: 'b1', resource_name: 'Barn 1', quantity: 1, arrival: '2026-09-10',
      departure: '2026-09-13', amount_cents: 10500, paid: false, status: 'held',
      contact_name: 'Dale', person_name: null },
    { id: 'b2', resource_name: 'North field', quantity: 4, arrival: '2026-09-10',
      departure: '2026-09-12', amount_cents: 8000, paid: true, status: 'confirmed',
      contact_name: null, person_name: 'Casey Roper' },
  ]),
  waiverTemplates: async () => ([
    { id: 't1', org_id: 'o1', name: 'Release', waiver_type: 'liability_release',
      body_text: 'Risk of livestock.', version: 1, is_active: true,
      required_by: [], applies_to_roles: ['contestant'], requires_notary: false },
  ]),
  waiverShortfall: async () => ([
    { contestant_id: 'p1', first_name: 'Casey', last_name: 'Roper',
      template_id: 't1', template_name: 'Release',
      waiver_type: 'liability_release', signed: true,
      signed_waiver_id: 'sw1', signed_at: '2026-09-10T12:00:00Z' },
    { contestant_id: 'p2', first_name: 'Dale', last_name: 'Walkup',
      template_id: 't1', template_name: 'Release',
      waiver_type: 'liability_release', signed: false,
      signed_waiver_id: null, signed_at: null },
  ]),
  verifyWaiver: async () => ({
    signed_waiver_id: 'sw1', text_matches: true, record_matches: true,
    template_changed_since: false,
  }),
  taxSummary: async () => ([
    { contestant_id: 'p1', first_name: 'Casey', last_name: 'Roper',
      address_line1: '1 Main', address_line2: null, city: 'Ada',
      state_province: 'OK', postal_code: '74820', country: 'US',
      tax_id_type: 'ssn', tax_id_last4: '1234', tax_id_verified: true,
      gross_cents: '230000', withholding_cents: '0', net_cents: '230000',
      payment_count: 2, form: '1099-NEC', threshold_cents: 200000,
      reportable: true, missing_tax_id: false },
    { contestant_id: 'p2', first_name: 'Dale', last_name: 'Walkup',
      address_line1: null, address_line2: null, city: null,
      state_province: null, postal_code: null, country: 'US',
      tax_id_type: null, tax_id_last4: null, tax_id_verified: false,
      gross_cents: '540000', withholding_cents: '0', net_cents: '540000',
      payment_count: 1, form: '1099-NEC', threshold_cents: 200000,
      reportable: true, missing_tax_id: true },
  ]),
};
Object.assign(apiMod.api, stub);
let bad = 0;
async function check(label, fn, mustContain) {
  byId.set('view', makeEl('div'));
  try {
    await fn();
    const text = countText(byId.get('view')).join(' ');
    const missing = mustContain.filter((m) => !text.includes(m));
    if (missing.length) { bad++; console.log(`FAIL  ${label} — missing: ${missing.join(' | ')}`); }
    else console.log(`  ok  ${label}`);
    if (process.env.DUMP) console.log('      >>', text.slice(0, 700));
  } catch (e) {
    bad++;
    console.log(`FAIL  ${label} — threw: ${e.message}`);
  }
}

const g = await import(`${W}/views/grounds.js`);
await check('grounds renders', () => g.groundsView('r1'), [
  'Barn 1', 'North field', 'Taken', '1 of 1',
  '$35.00/night',
  '2 live · 1 unpaid', '$105.00 outstanding',   // derived from rows, not meta
]);

const w = await import(`${W}/views/waivers.js`);
await check('releases renders', () => w.waiversView('r1'), [
  'Casey Roper', 'Dale Walkup', 'On file', 'Missing', 'Check it',
  '1 contestant(s) still owe 1 release(s).',  // derived from rows, not meta
]);

const y = await import(`${W}/views/yearend.js`);
await check('year-end renders', () => y.yearEndView(), [
  'Casey Roper', 'Dale Walkup',
  '1099-NEC · threshold $2,000.00 for ',      // from the row, not meta
  '2 paid · 2 reportable · 1 over the threshold with no verified W-9',
  '$2,300.00', '$5,400.00', 'None',
]);

console.log(bad === 0 ? '\n✓ all three views render with real numbers' : `\n✗ ${bad} view(s) wrong`);
process.exit(bad ? 1 : 0);
