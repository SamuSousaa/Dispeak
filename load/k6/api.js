// REST API under load: members of one busy server reading it, reading history and chatting.
//
//   k6 run load/k6/api.js
//   k6 run -e BASE_URL=https://example.com -e VUS=100 load/k6/api.js
//
// Run the API with generous rate limits (RATE_LIMIT_MAX, RATE_LIMIT_MESSAGES_MAX): every
// virtual user comes from the same address.
import { check, sleep } from 'k6';
import http from 'k6/http';
import { acceptInvite, authHeaders, BASE_URL, createGuild, register } from './lib.js';

const VUS = Number(__ENV.VUS || 50);

export const options = {
  scenarios: {
    members: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: VUS },
        { duration: '60s', target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Listed per endpoint so the summary shows each one separately.
    'http_req_duration{name:GET /guilds/:id}': ['p(95)<300'],
    'http_req_duration{name:GET /channels/:id/messages}': ['p(95)<300'],
    'http_req_duration{name:POST /channels/:id/messages}': ['p(95)<300'],
    // Registration is slow on purpose (argon2id); it is reported, not constrained.
    'http_req_duration{name:POST /auth/register}': ['p(95)<5000'],
  },
};

export function setup() {
  const owner = register('owner');
  return createGuild(owner, 'Carga API');
}

// Module scope is per virtual user: each one registers and joins once.
let account;

export default function (data) {
  if (!account) {
    account = register('vu');
    acceptInvite(account, data.inviteCode);
  }
  const headers = authHeaders(account.token);
  const roll = Math.random();

  if (roll < 0.5) {
    const response = http.get(`${BASE_URL}/api/guilds/${data.guildId}`, {
      headers,
      tags: { name: 'GET /guilds/:id' },
    });
    check(response, { 'guild loaded': (r) => r.status === 200 });
  } else if (roll < 0.8) {
    const response = http.get(`${BASE_URL}/api/channels/${data.textChannelId}/messages`, {
      headers,
      tags: { name: 'GET /channels/:id/messages' },
    });
    check(response, { 'history loaded': (r) => r.status === 200 });
  } else {
    const response = http.post(
      `${BASE_URL}/api/channels/${data.textChannelId}/messages`,
      JSON.stringify({ content: `mensagem de carga ${Date.now()}` }),
      { headers, tags: { name: 'POST /channels/:id/messages' } },
    );
    check(response, { 'message sent': (r) => r.status === 201 });
  }
  sleep(0.5 + Math.random());
}
