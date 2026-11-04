import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, prisma } from './app.js';

let app: FastifyInstance;
let sequence = 0;
const prefix = `vt${Date.now().toString(36)}_`;
const password = 'ConnectlyTest123!';

type TestUser = { id: string; username: string; token: string; cookieHeader: string; csrf: string };

function newUsername(label: string) {
  return `${prefix}${label}${sequence++}`.slice(0, 30);
}

function parsedCookies(response: { headers: Record<string, unknown> }): Record<string, string> {
  const raw = response.headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const result: Record<string, string> = {};
  for (const value of values) {
    const first = value.split(';')[0];
    const index = first.indexOf('=');
    if (index !== -1) result[first.slice(0, index)] = decodeURIComponent(first.slice(index + 1));
  }
  return result;
}

function cookieHeader(cookies: Record<string, string>) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

async function createUser(label: string): Promise<TestUser> {
  const username = newUsername(label);
  const register = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      username,
      displayName: `${label} User`,
      password,
      gender: 'PREFER_NOT_TO_SAY',
      device: { deviceName: 'Vitest Browser', platform: 'WEB' },
    },
  });
  expect(register.statusCode).toBe(201);
  const registered = register.json();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password, device: { deviceName: 'Vitest Browser', platform: 'WEB' } },
  });
  expect(login.statusCode).toBe(200);
  const cookies = parsedCookies(login);
  return {
    id: registered.id,
    username,
    token: login.json().accessToken,
    cookieHeader: cookieHeader(cookies),
    csrf: cookies.connectly_csrf,
  };
}

function authHeaders(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

beforeAll(async () => {
  app = buildApp({ withSocket: false });
  await app.ready();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { username: { startsWith: prefix } } });
  await prisma.conversation.deleteMany({ where: { members: { none: {} }, messages: { none: {} } } });
  await app.close();
  await prisma.$disconnect();
});

describe('authentication and sessions', () => {
  it('registers, logs in and returns the current user', async () => {
    const username = newUsername('auth');
    const register = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username,
        displayName: 'Auth User',
        password,
        device: { deviceName: 'Vitest Browser', platform: 'WEB' },
      },
    });
    expect(register.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        username,
        displayName: 'Auth User',
        password,
        device: { deviceName: 'Vitest Browser', platform: 'WEB' },
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username, password, device: { deviceName: 'Vitest Browser', platform: 'WEB' } },
    });
    expect(login.statusCode).toBe(200);
    const setCookie = login.headers['set-cookie'];
    expect(String(setCookie)).toContain('connectly_refresh=');
    expect(String(setCookie)).toContain('HttpOnly');
    expect(String(setCookie)).toContain('connectly_csrf=');
    expect(login.json().user.username).toBe(username);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders({ token: login.json().accessToken } as TestUser) });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe(username);

    const badLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'wrong-password' } });
    expect(badLogin.statusCode).toBe(401);
  });

  it('rotates refresh tokens and detects reuse', async () => {
    const user = await createUser('rotate');
    const cookies = Object.fromEntries(
      user.cookieHeader.split('; ').map((part) => {
        const index = part.indexOf('=');
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
    );
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().accessToken).toBeTruthy();
    const rotatedCookies = parsedCookies(refresh);
    expect(rotatedCookies.connectly_refresh).not.toBe(cookies.connectly_refresh);

    const reused = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().code).toBe('TOKEN_REUSED');

    const afterReuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: {
        cookie: cookieHeader(rotatedCookies),
        'x-csrf-token': rotatedCookies.connectly_csrf,
      },
    });
    expect(afterReuse.statusCode).toBe(401);
  });

  it('rejects expired sessions and missing CSRF tokens', async () => {
    const user = await createUser('expire');
    const found = await prisma.user.findUnique({ where: { username: user.username } });
    expect(found).toBeTruthy();
    await prisma.session.updateMany({ where: { userId: found!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('SESSION_EXPIRED');

    const second = await createUser('csrf');
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', headers: { cookie: second.cookieHeader } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('CSRF_FAILED');
  });

  it('does not revoke the winning session during concurrent refresh', async () => {
    const user = await createUser('concurrent');
    const requests = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/v1/auth/refresh',
          headers: { cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
        }),
      ),
    );
    expect(requests.some((response) => response.statusCode === 200)).toBe(true);
    expect(requests.filter((response) => response.statusCode === 401).map((response) => response.json().code)).toEqual(
      expect.arrayContaining(['TOKEN_REUSED']),
    );
    const activeSessions = await prisma.session.count({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
    });
    expect(activeSessions).toBe(1);
  });

  it('bootstraps a CSRF token without exposing the refresh token', async () => {
    const csrf = await app.inject({ method: 'GET', url: '/api/v1/auth/csrf' });
    expect(csrf.statusCode).toBe(200);
    expect(csrf.json().csrfToken).toBeTruthy();
    expect(String(csrf.headers['set-cookie'])).toContain('connectly_csrf=');
    expect(String(csrf.headers['set-cookie'])).not.toContain('HttpOnly');
  });

  it('logs out and revokes the session', async () => {
    const user = await createUser('logout');
    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { ...authHeaders(user), cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
    });
    expect(logout.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: authHeaders(user) });
    expect(me.statusCode).toBe(401);
    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      headers: { cookie: user.cookieHeader, 'x-csrf-token': user.csrf },
    });
    expect(refresh.statusCode).toBe(401);
  });
});

describe('friend requests', () => {
  it('prevents self requests and duplicate pending requests', async () => {
    const a = await createUser('selfa');
    const b = await createUser('selfb');

    const self = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: a.username },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe('SELF_REQUEST');

    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().status).toBe('PENDING');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('REQUEST_ALREADY_SENT');

    const search = await app.inject({ method: 'GET', url: `/api/v1/users/search?q=${encodeURIComponent(b.username)}`, headers: authHeaders(a) });
    expect(search.statusCode).toBe(200);
    expect(search.json().relationship).toBe('SENT');
  });

  it('handles opposite-direction requests without duplicates', async () => {
    const a = await createUser('oppa');
    const b = await createUser('oppb');

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(first.statusCode).toBe(201);

    const opposite = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(b),
      payload: { username: a.username },
    });
    expect(opposite.statusCode).toBe(409);
    expect(opposite.json().code).toBe('OPPOSITE_PENDING');
    expect(opposite.json().request.id).toBe(first.json().id);

    const incoming = await app.inject({ method: 'GET', url: '/api/v1/friend-requests?type=incoming', headers: authHeaders(b) });
    expect(incoming.statusCode).toBe(200);
    expect(incoming.json().incoming).toHaveLength(1);

    const accepted = await app.inject({
      method: 'POST',
      url: `/api/v1/friend-requests/${first.json().id}/accept`,
      headers: authHeaders(b),
    });
    expect(accepted.statusCode).toBe(200);

    const friendsA = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: authHeaders(a) });
    const friendsB = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: authHeaders(b) });
    expect(friendsA.json().some((entry: { friend: { id: string } }) => entry.friend.id === b.id)).toBe(true);
    expect(friendsB.json().some((entry: { friend: { id: string } }) => entry.friend.id === a.id)).toBe(true);

    // Accepted requests must disappear from the default request inbox/outbox;
    // the accepted relationship is now represented by the Friends endpoint.
    const requestsA = await app.inject({ method: 'GET', url: '/api/v1/friend-requests', headers: authHeaders(a) });
    const requestsB = await app.inject({ method: 'GET', url: '/api/v1/friend-requests', headers: authHeaders(b) });
    expect(requestsA.json().incoming).toHaveLength(0);
    expect(requestsA.json().outgoing).toHaveLength(0);
    expect(requestsB.json().incoming).toHaveLength(0);
    expect(requestsB.json().outgoing).toHaveLength(0);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().code).toBe('ALREADY_FRIENDS');
  });

  it('rejects and cancels requests with authorization checks', async () => {
    const a = await createUser('rejA');
    const b = await createUser('rejB');
    const third = await createUser('rejC');
    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    const requestId = sent.json().id;

    const unauthorized = await app.inject({
      method: 'POST',
      url: `/api/v1/friend-requests/${requestId}/accept`,
      headers: authHeaders(third),
    });
    expect(unauthorized.statusCode).toBe(403);

    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v1/friend-requests/${requestId}/reject`,
      headers: authHeaders(b),
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json().request.status).toBe('REJECTED');

    const friends = await app.inject({ method: 'GET', url: '/api/v1/friends', headers: authHeaders(a) });
    expect(friends.json().some((entry: { friend: { id: string } }) => entry.friend.id === b.id)).toBe(false);

    const c = await createUser('canC');
    const d = await createUser('canD');
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(c),
      payload: { username: d.username },
    });
    const cancelled = await app.inject({
      method: 'POST',
      url: `/api/v1/friend-requests/${second.json().id}/cancel`,
      headers: authHeaders(c),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().request.status).toBe('CANCELLED');
    const incoming = await app.inject({ method: 'GET', url: '/api/v1/friend-requests?type=incoming', headers: authHeaders(d) });
    expect(incoming.json().incoming).toHaveLength(0);
  });

  it('blocks friend requests between blocked users and requires authentication', async () => {
    const a = await createUser('blkA');
    const b = await createUser('blkB');
    const block = await app.inject({
      method: 'POST',
      url: `/api/v1/users/${encodeURIComponent(a.username)}/block`,
      headers: authHeaders(b),
    });
    expect(block.statusCode).toBe(200);
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('BLOCKED');

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/friends' });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it('only allows direct conversations between friends', async () => {
    const a = await createUser('convA');
    const b = await createUser('convB');
    const before = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/direct',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(before.statusCode).toBe(403);
    expect(before.json().code).toBe('NOT_FRIENDS');

    const sent = await app.inject({
      method: 'POST',
      url: '/api/v1/friend-requests',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    await app.inject({ method: 'POST', url: `/api/v1/friend-requests/${sent.json().id}/accept`, headers: authHeaders(b) });

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations/direct',
      headers: authHeaders(a),
      payload: { username: b.username },
    });
    expect(after.statusCode).toBe(201);
    expect(after.json().members).toHaveLength(2);
  });
});
