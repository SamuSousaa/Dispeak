// Realtime gateway under load: many members connected to the same server while a few of
// them chat. Measures how long a message takes to reach every connected member.
//
//   k6 run load/k6/gateway.js
//   k6 run -e BASE_URL=https://example.com -e VUS=300 -e MESSAGES_PER_SECOND=10 load/k6/gateway.js
import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';
import { acceptInvite, authHeaders, BASE_URL, createGuild, register, WS_URL } from './lib.js';

const VUS = Number(__ENV.VUS || 200);
const MESSAGES_PER_SECOND = Number(__ENV.MESSAGES_PER_SECOND || 5);
const HOLD_SECONDS = Number(__ENV.HOLD_SECONDS || 60);
const RAMP_SECONDS = 20;
const SESSION_MS = (RAMP_SECONDS + HOLD_SECONDS) * 1000;

const readyTime = new Trend('gateway_ready_ms', true);
const deliveryLatency = new Trend('gateway_delivery_latency_ms', true);
const eventsReceived = new Counter('gateway_events_received');
const heartbeatsAcked = new Counter('gateway_heartbeats_acked');

export const options = {
  scenarios: {
    listeners: {
      executor: 'ramping-vus',
      exec: 'listen',
      startVUs: 0,
      stages: [
        { duration: `${RAMP_SECONDS}s`, target: VUS },
        { duration: `${HOLD_SECONDS}s`, target: VUS },
      ],
      gracefulRampDown: '0s',
      gracefulStop: '5s',
    },
    chatters: {
      executor: 'constant-arrival-rate',
      exec: 'chat',
      startTime: `${RAMP_SECONDS}s`,
      duration: `${HOLD_SECONDS - 5}s`,
      rate: MESSAGES_PER_SECOND,
      timeUnit: '1s',
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    gateway_ready_ms: ['p(95)<2000'],
    gateway_delivery_latency_ms: ['p(95)<250'],
    checks: ['rate>0.99'],
  },
};

export function setup() {
  const owner = register('owner');
  const guild = createGuild(owner, 'Carga Gateway');
  // Chatters are ordinary members with their own accounts.
  const chatters = [];
  for (let i = 0; i < 10; i++) {
    const account = register('chat');
    acceptInvite(account, guild.inviteCode);
    chatters.push(account.token);
  }
  return { ...guild, chatters };
}

let account;

export function listen(data) {
  if (!account) {
    account = register('ws');
    acceptInvite(account, data.inviteCode);
  }

  const openedAt = Date.now();
  let ready = false;
  const response = ws.connect(`${WS_URL}/api/gateway`, {}, (socket) => {
    let seq = null;

    socket.on('message', (raw) => {
      const frame = JSON.parse(raw);
      switch (frame.op) {
        case 10: // HELLO
          socket.send(JSON.stringify({ op: 2, d: { token: account.token } }));
          socket.setInterval(
            () => socket.send(JSON.stringify({ op: 1, d: seq })),
            frame.d.heartbeatInterval,
          );
          break;
        case 11: // HEARTBEAT_ACK
          heartbeatsAcked.add(1);
          break;
        case 0: // DISPATCH
          seq = frame.s;
          eventsReceived.add(1);
          if (frame.t === 'READY') {
            ready = true;
            readyTime.add(Date.now() - openedAt);
          } else if (frame.t === 'MESSAGE_CREATE') {
            // The sender put its clock in the message; both run on the load generator.
            const sentAt = Number(frame.d.content.split(' ').pop());
            if (sentAt) deliveryLatency.add(Date.now() - sentAt);
          }
          break;
      }
    });

    // Stay connected for the whole test, then leave cleanly.
    socket.setTimeout(() => socket.close(), Math.max(1000, SESSION_MS - (Date.now() - START)));
  });

  check(response, { 'gateway upgraded': (r) => r && r.status === 101 });
  check(ready, { 'received READY': (value) => value === true });
  sleep(1);
}

/** Test start as seen by this VU; sessions end together regardless of when they began. */
const START = Date.now();

export function chat(data) {
  const token = data.chatters[Math.floor(Math.random() * data.chatters.length)];
  const response = http.post(
    `${BASE_URL}/api/channels/${data.textChannelId}/messages`,
    JSON.stringify({ content: `carga ${Date.now()}` }),
    { headers: authHeaders(token), tags: { name: 'POST /channels/:id/messages' } },
  );
  check(response, { 'message sent': (r) => r.status === 201 });
}
