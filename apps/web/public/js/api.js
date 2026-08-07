/**
 * API client.
 *
 * Every response from this API is `{ data, meta }` or `{ error, meta }`, so
 * this unwraps that once and throws an ApiError carrying the code and the
 * details. The details matter: a blocked close returns its blockers in
 * `error.details.blockers`, and the books screen renders them.
 */

let config = { api_origin: '' };
let token = localStorage.getItem('rodeo.token') ?? '';
let orgId = localStorage.getItem('rodeo.org') ?? '';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function init() {
  try {
    const res = await fetch('/config.json');
    config = await res.json();
  } catch {
    // Served from a static host with no config endpoint: same origin.
    config = { api_origin: '' };
  }
}

export function setSession(nextToken, nextOrg) {
  token = nextToken;
  orgId = nextOrg;
  localStorage.setItem('rodeo.token', nextToken);
  localStorage.setItem('rodeo.org', nextOrg);
}

export function session() {
  return { token, orgId, configured: Boolean(token && orgId) };
}

export function clearSession() {
  token = '';
  orgId = '';
  localStorage.removeItem('rodeo.token');
  localStorage.removeItem('rodeo.org');
}

async function request(method, path, body, asText = false) {
  const url = `${config.api_origin}/v1/orgs/${orgId}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (asText) {
    if (!res.ok) throw new ApiError(res.status, 'HTTP_ERROR', await res.text());
    return res.text();
  }

  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = payload.error ?? {};
    throw new ApiError(res.status, e.code ?? 'HTTP_ERROR', e.message ?? res.statusText, e.details);
  }
  return payload.data;
}

export const api = {
  options: () => request('GET', '/options'),
  associations: () => request('GET', '/associations'),

  rodeos: () => request('GET', '/rodeos'),
  rodeo: (id) => request('GET', `/rodeos/${id}`),
  createRodeo: (body) => request('POST', '/rodeos', body),

  daySheet: (id, performance) =>
    request(
      'GET',
      `/rodeos/${id}/day-sheet${performance != null ? `?performance=${performance}` : ''}`,
    ),
  daySheetText: (id, performance) =>
    request(
      'GET',
      `/rodeos/${id}/day-sheet?format=text${performance != null ? `&performance=${performance}` : ''}`,
      null,
      true,
    ),

  books: (id) => request('GET', `/rodeos/${id}/books`),
  closeBooks: (id) => request('POST', `/rodeos/${id}/books/close`, {}),
  fileBooks: (id, reference, late) =>
    request('POST', `/rodeos/${id}/books/file`, { reference, late }),
  reopenBooks: (id, reason) => request('POST', `/rodeos/${id}/books/reopen`, { reason }),

  compliance: (id) => request('GET', `/rodeos/${id}/compliance`),
  generateCompliance: (id) => request('POST', `/rodeos/${id}/compliance/generate`, {}),
  patchCompliance: (id, itemId, patch) =>
    request('PATCH', `/rodeos/${id}/compliance/${itemId}`, patch),

  submitScore: (eventId, body) => request('POST', `/events/${eventId}/scores`, body),
  finalize: (rodeoId, eventId, official) =>
    request('POST', `/rodeos/${rodeoId}/events/${eventId}/finalize`, { official }),

  career: (contestantId) => request('GET', `/contestants/${contestantId}/career`),
  registrySearch: (q, type) =>
    request('GET', `/registry?q=${encodeURIComponent(q)}${type ? `&type=${type}` : ''}`),
};
