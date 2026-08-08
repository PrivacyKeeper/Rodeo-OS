/**
 * Router and bootstrap.
 *
 * Hash routing, no framework, no build. Every view is an async function that
 * fetches what it needs and calls render(). If one throws, the error is shown
 * on the page rather than swallowed into a console the secretary will never
 * open.
 */

import { api, init, session, setSession, clearSession } from './api.js';
import { crumbs, h, render, showPrint, toast } from './ui.js';

const routes = [
  [/^\/?$/, () => import('./views/rodeo.js').then((m) => m.listView())],
  [/^\/new$/, () => import('./views/setup.js').then((m) => m.setupView())],
  [/^\/rodeo\/([0-9a-f-]{36})$/, (id) =>
    import('./views/rodeo.js').then((m) => m.rodeoView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet$/, (id) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, null))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet\/all$/, (id) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, null))],
  [/^\/rodeo\/([0-9a-f-]{36})\/daysheet\/(\d+)$/, (id, perf) =>
    import('./views/daysheet.js').then((m) => m.daySheetView(id, Number(perf)))],
  [/^\/rodeo\/([0-9a-f-]{36})\/entries$/, (id) =>
    import('./views/entries.js').then((m) => m.entriesView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/draw$/, (id) =>
    import('./views/draw.js').then((m) => m.drawView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/payouts$/, (id) =>
    import('./views/payouts.js').then((m) => m.payoutsView(id))],
  [/^\/contestant\/([0-9a-f-]{36})$/, (id) =>
    import('./views/contestant.js').then((m) => m.contestantView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/scoring$/, (id) =>
    import('./views/scoring.js').then((m) => m.scoringView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/books$/, (id) =>
    import('./views/books.js').then((m) => m.booksView(id))],
  [/^\/rodeo\/([0-9a-f-]{36})\/compliance$/, (id) =>
    import('./views/compliance.js').then((m) => m.complianceView(id))],
  [/^\/settings$/, () => settingsView()],
];

/**
 * Where the session comes from.
 *
 * Supabase Auth is not wired into this app yet, so the token and the
 * organisation are pasted in once and kept in localStorage. That is stated
 * plainly on the screen rather than hidden behind a fake login: pretending to
 * have authentication that does not exist is how a demo gets deployed.
 */
function settingsView() {
  crumbs({ label: 'Settings' });
  showPrint(null);
  const { token, orgId } = session();

  const tokenInput = h('input', {
    name: 'token', value: token, placeholder: 'eyJhbGciOi…', autocomplete: 'off',
  });
  const orgInput = h('input', {
    name: 'org', value: orgId, placeholder: '00000000-0000-0000-0000-000000000000',
  });

  render(
    h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        setSession(tokenInput.value.trim(), orgInput.value.trim());
        toast('Saved.');
        location.hash = '#/';
      },
    },
      h('h1', {}, 'Connection'),
      h('div', { class: 'card' },
        h('p', { class: 'muted' },
          'Supabase Auth is not wired into this interface yet. Until it is, paste ' +
          'an access token and the organisation id. The token is sent as a bearer ' +
          'header and is never stored anywhere but this browser.'),
        h('label', {}, 'Access token', tokenInput),
        h('label', {}, 'Organisation id', orgInput),
        h('div', { class: 'actions' },
          h('button', { type: 'submit' }, 'Save'),
          h('button', {
            type: 'button', class: 'ghost',
            onclick: () => { clearSession(); toast('Cleared.'); location.hash = '#/settings'; },
          }, 'Clear'),
        ),
      ),
    ),
  );
}

function notFound() {
  crumbs({ label: 'Not found' });
  render(h('div', { class: 'card' },
    h('h1', {}, 'No such page'),
    h('p', {}, h('a', { href: '#/' }, 'Back to rodeos')),
  ));
}

function showError(err) {
  crumbs({ label: 'Error' });
  showPrint(null);
  render(h('div', { class: 'card' },
    h('h1', {}, 'That did not work'),
    h('p', {}, err.message ?? String(err)),
    err.code ? h('p', { class: 'muted small' }, err.code) : null,
    h('div', { class: 'actions' },
      h('a', { class: 'row-link', href: '#/', style: 'padding:10px 18px' }, 'Back'),
      h('a', { class: 'row-link', href: '#/settings', style: 'padding:10px 18px' }, 'Connection'),
    ),
  ));
}

async function route() {
  const path = location.hash.replace(/^#/, '') || '/';

  if (!session().configured && path !== '/settings') {
    location.hash = '#/settings';
    return;
  }

  for (const [pattern, handler] of routes) {
    const match = pattern.exec(path);
    if (!match) continue;
    try {
      document.getElementById('view').replaceChildren(
        h('div', { class: 'loading' }, 'Loading…'),
      );
      await handler(...match.slice(1));
    } catch (err) {
      showError(err);
    }
    return;
  }
  notFound();
}

window.addEventListener('hashchange', route);

await init();
const org = session().orgId;
if (org) {
  document.getElementById('orgLabel').textContent = `org ${org.slice(0, 8)}`;
}
await route();
