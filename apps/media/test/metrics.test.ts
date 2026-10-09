import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  openTransport,
  opusRtpParameters,
  simulcastRtpParameters,
  type Harness,
} from './helpers/harness';

describe('GET /media/metrics', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  const scrape = async () => {
    const response = await fetch(`http://127.0.0.1:${h.server.port}/media/metrics`);
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      body: await response.text(),
    };
  };
  const value = (body: string, metric: string) => {
    const line = body.split('\n').find((entry) => entry.startsWith(metric));
    return line ? Number(line.split(' ').at(-1)) : undefined;
  };

  it('exposes voice channels, participants, producers, consumers and worker CPU', async () => {
    const alice = await h.joinAs();
    const bob = await h.joinAs();
    const send = await openTransport(alice, 'send');
    const mic = await alice.rpc.request('produce', {
      transportId: send,
      kind: 'audio',
      source: 'mic',
      rtpParameters: opusRtpParameters(),
    });
    await alice.rpc.request('produce', {
      transportId: send,
      kind: 'video',
      source: 'screen',
      rtpParameters: simulcastRtpParameters(),
    });
    await openTransport(bob, 'recv');
    await bob.rpc.request('consume', { producerId: mic.producerId });

    const { status, type, body } = await scrape();
    expect(status).toBe(200);
    expect(type).toContain('text/plain');
    expect(value(body, 'frequencia_voice_channels_active{')).toBe(1);
    expect(value(body, 'frequencia_voice_participants{')).toBe(2);
    expect(value(body, 'frequencia_media_transports{')).toBe(2);
    expect(value(body, 'frequencia_media_producers{source="mic"')).toBe(1);
    expect(value(body, 'frequencia_media_producers{source="screen"')).toBe(1);
    expect(value(body, 'frequencia_media_consumers{source="mic"')).toBe(1);
    expect(value(body, 'frequencia_media_consumers{source="screen"')).toBe(0);
    expect(value(body, 'frequencia_media_signaling_connections{')).toBe(2);
    expect(value(body, 'frequencia_media_worker_routers{worker="0"')).toBe(1);
    expect(body).toContain('frequencia_media_worker_cpu_seconds_total');
    expect(body).toContain('process_cpu_user_seconds_total');
  });

  it('drops back to zero when the channel empties', async () => {
    const alice = await h.joinAs();
    await alice.rpc.request('leave', {});
    await alice.closed;
    const { body } = await scrape();
    expect(value(body, 'frequencia_voice_channels_active{')).toBe(0);
    expect(value(body, 'frequencia_voice_participants{')).toBe(0);
  });
});
