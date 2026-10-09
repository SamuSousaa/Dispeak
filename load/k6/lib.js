import { check, fail } from 'k6';
import http from 'k6/http';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
export const WS_URL = BASE_URL.replace(/^http/, 'ws');

const json = { 'Content-Type': 'application/json' };

export const authHeaders = (token) => ({ ...json, Authorization: `Bearer ${token}` });

/** Unique per run, per VU and per call, so reruns never collide on usernames. */
export function uniqueName(prefix) {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36)}${random}`.slice(0, 24);
}

/** Creates an account. Returns `{ token, userId }`. */
export function register(prefix = 'load') {
  const response = http.post(
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ username: uniqueName(prefix), password: 'correct horse battery' }),
    { headers: json, tags: { name: 'POST /auth/register' } },
  );
  if (!check(response, { registered: (r) => r.status === 200 })) {
    fail(`register failed: ${response.status} ${response.body}`);
  }
  const body = response.json();
  return { token: body.accessToken, userId: body.user.id };
}

/** Creates a guild with an unlimited invite. Returns ids the scenarios need. */
export function createGuild(owner, name) {
  const guild = http
    .post(`${BASE_URL}/api/guilds`, JSON.stringify({ name }), {
      headers: authHeaders(owner.token),
      tags: { name: 'POST /guilds' },
    })
    .json();
  const invite = http
    .post(`${BASE_URL}/api/guilds/${guild.id}/invites`, JSON.stringify({}), {
      headers: authHeaders(owner.token),
      tags: { name: 'POST /guilds/:id/invites' },
    })
    .json();
  return {
    guildId: guild.id,
    textChannelId: guild.channels.find((channel) => channel.type === 'text').id,
    voiceChannelId: guild.channels.find((channel) => channel.type === 'voice').id,
    inviteCode: invite.code,
  };
}

export function acceptInvite(account, inviteCode) {
  // No body, so no JSON content type either (the API rejects an empty JSON body).
  const response = http.post(`${BASE_URL}/api/invites/${inviteCode}/accept`, null, {
    headers: { Authorization: `Bearer ${account.token}` },
    tags: { name: 'POST /invites/:code/accept' },
  });
  check(response, { 'joined guild': (r) => r.status === 200 });
}
