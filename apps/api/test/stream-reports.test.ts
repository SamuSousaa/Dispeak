import { randomUUID } from 'node:crypto';
import type {
  StreamReport,
  StreamReportSummary,
  StreamSample,
  StreamServerSample,
} from '@frequencia/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Account, type TestApp } from './helpers/app';
import { startFakeMedia, type FakeMedia } from './helpers/fake-media';

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const server: StreamServerSample = {
  fps: 59.8,
  gapP50Ms: 16,
  gapP95Ms: 20,
  gapMaxMs: 34,
  kbps: 7800,
  keyFrames: 0,
  packetsLost: 0,
  nacks: 0,
  plis: 0,
};
const sample = (t: number): StreamSample => ({ t, server, sender: null, viewers: [] });

describe('stream reports', () => {
  let media: FakeMedia;
  let t: TestApp;

  beforeAll(async () => {
    media = await startFakeMedia();
    t = await createTestApp({ MEDIA_INTERNAL_URL: media.url, MEDIA_SHARED_SECRET: media.secret });
    await eventually(() => expect(media.links()).toBe(1));
  });

  afterAll(async () => {
    await t.close();
    await media.close();
  });

  const list = async (account: Account) =>
    (await t.request('GET', '/stream-reports', { token: account.token })).json<{
      reports: StreamReportSummary[];
    }>().reports;

  it('joins the chunks of a stream and shows it to the streamer and the owner only', async () => {
    const [owner, streamer, other] = await Promise.all([
      t.account('Dona'),
      t.account('Transmite'),
      t.account('Outra'),
    ]);
    const guild = await t.createGuild(owner);
    await t.join(guild, owner, streamer);
    await t.join(guild, owner, other);
    const voice = guild.channels.find((channel) => channel.type === 'voice');
    if (!voice) throw new Error('default voice channel missing');

    const producerId = randomUUID();
    const base = {
      producerId,
      roomId: voice.id,
      userId: streamer.user.id,
      path: 'native' as const,
      codec: 'AV1',
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    };
    media.report({ ...base, eventId: 'r:1', endedAt: null, samples: [sample(5), sample(10)] });
    // The same event again, as a second API instance would also receive: stored once.
    media.report({ ...base, eventId: 'r:1', endedAt: null, samples: [sample(5), sample(10)] });
    const endedAt = new Date().toISOString();
    media.report({ ...base, eventId: 'r:2', endedAt, samples: [sample(15)] });

    await eventually(async () => {
      expect(await list(streamer)).toEqual([
        {
          id: producerId,
          channelId: voice.id,
          channelName: voice.name,
          guildName: guild.name,
          userId: streamer.user.id,
          userName: streamer.user.displayName,
          path: 'native',
          codec: 'AV1',
          startedAt: base.startedAt,
          endedAt,
          sampleCount: 3,
        },
      ]);
    });
    expect((await list(owner)).map((report) => report.id)).toEqual([producerId]);
    expect(await list(other)).toEqual([]);

    const detail = await t.request('GET', `/stream-reports/${producerId}`, {
      token: owner.token,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<StreamReport>().samples.map((entry) => entry.t)).toEqual([5, 10, 15]);
    const hidden = await t.request('GET', `/stream-reports/${producerId}`, { token: other.token });
    expect(hidden.statusCode).toBe(404);
  });

  it('ignores streams of rooms that are not channels', async () => {
    const streamer = await t.account('Laboratorio');
    media.report({
      eventId: 'lab:1',
      producerId: randomUUID(),
      roomId: 'lab-room',
      userId: streamer.user.id,
      path: 'browser',
      codec: 'VP8',
      startedAt: new Date().toISOString(),
      endedAt: null,
      samples: [sample(5)],
    });
    // Give the event time to arrive: nothing should come of it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await list(streamer)).toEqual([]);
  });
});
