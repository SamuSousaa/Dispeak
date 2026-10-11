import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

interface PeerStats {
  name: string;
  producers: Array<{ id: string; source: string; type: string; layers: number }>;
  consumers: Array<{
    producerId: string;
    source: string;
    paused: boolean;
    preferredSpatialLayer: number | null;
  }>;
}

async function peers(request: APIRequestContext, channel: string): Promise<PeerStats[]> {
  // Outside development the endpoint asks for the secret shared with the API.
  const secret = process.env.E2E_MEDIA_SECRET;
  const response = await request.get('/media/stats', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  const stats = (await response.json()) as { rooms: Array<{ id: string; peers: PeerStats[] }> };
  return stats.rooms.find((room) => room.id === `lab:${channel}`)?.peers ?? [];
}

const peerNamed = async (request: APIRequestContext, channel: string, name: string) =>
  (await peers(request, channel)).find((peer) => peer.name === name);

async function join(browser: Browser, channel: string, nickname: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/lab/voice?canal=${channel}`);
  await page.getByLabel('APELIDO').fill(nickname);
  await page.getByRole('button', { name: 'ENTRAR' }).click();
  await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  return page;
}

async function share(page: Page, preset: string): Promise<void> {
  await page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(preset) }).click();
  await expect(page.getByRole('button', { name: 'PARAR TRANSMISSÃO' }).first()).toBeVisible();
}

const stream = (page: Page, name: string) => page.locator(`[data-stream="${name}"]`);
const videoWidth = (page: Page, name: string) =>
  stream(page, name)
    .getByTestId('stream-video')
    .evaluate((element) => (element as HTMLVideoElement).videoWidth);

test('two simultaneous streams; a viewer only receives the one being watched', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const channel = `e2e-ss-${Date.now()}`;
  const alice = await join(browser, channel, 'Alice');
  const bruno = await join(browser, channel, 'Bruno');
  const carla = await join(browser, channel, 'Carla');

  await share(alice, '720P30');
  await share(bruno, '1080P30');

  // Whether system audio comes along depends on the browser and the captured surface. The
  // streamer is warned exactly when the share went out without an audio producer.
  const sharesAudio = async (name: string) =>
    Boolean(
      (await peerNamed(request, channel, name))?.producers.some(
        (producer) => producer.source === 'screen-audio',
      ),
    );
  await expect(alice.getByTestId('screen-no-audio')).toHaveCount(
    (await sharesAudio('Alice')) ? 0 : 1,
  );
  await expect(alice.getByTestId('screen-preset')).toHaveText('720P30');
  // Each streamer sees a local preview of its own share.
  await expect(stream(alice, 'self')).toBeVisible();

  // Both streams are published as three-layer simulcast.
  await expect
    .poll(async () =>
      (await peers(request, channel)).flatMap((peer) =>
        peer.producers
          .filter((producer) => producer.source === 'screen')
          .map((producer) => [peer.name, producer.type, producer.layers]),
      ),
    )
    .toEqual([
      ['Alice', 'simulcast', 3],
      ['Bruno', 'simulcast', 3],
    ]);

  // Carla is told both are live but receives no video until she asks for it.
  await expect(carla.locator('[data-testid="participant"][data-live="true"]')).toHaveCount(2);
  expect((await peerNamed(request, channel, 'Carla'))?.consumers.map((c) => c.source)).toEqual([
    'mic',
    'mic',
  ]);

  await carla.getByRole('button', { name: 'Assistir Alice' }).click();
  await expect(stream(carla, 'Alice')).toBeVisible();
  await expect.poll(() => videoWidth(carla, 'Alice')).toBeGreaterThan(0);

  // Server statistics: exactly one video consumer, and it is fed by Alice's producer.
  const aliceScreen = (await peerNamed(request, channel, 'Alice'))?.producers.find(
    (producer) => producer.source === 'screen',
  );
  const brunoScreen = (await peerNamed(request, channel, 'Bruno'))?.producers.find(
    (producer) => producer.source === 'screen',
  );
  expect(aliceScreen && brunoScreen).toBeTruthy();
  await expect
    .poll(async () =>
      (await peerNamed(request, channel, 'Carla'))?.consumers
        .filter((consumer) => consumer.source === 'screen')
        .map((consumer) => [consumer.producerId, consumer.paused]),
    )
    .toEqual([[aliceScreen?.id, false]]);
  const everyConsumer = (await peers(request, channel)).flatMap((peer) => peer.consumers);
  expect(everyConsumer.some((consumer) => consumer.producerId === brunoScreen?.id)).toBe(false);

  // Real statistics from getStats() in the viewer's panel.
  await stream(carla, 'Alice').hover();
  await stream(carla, 'Alice').getByRole('button', { name: 'Estatísticas' }).click();
  const panel = stream(carla, 'Alice').getByTestId('stream-stats');
  // H.264 where the graphics card encodes it (the installed Chrome), VP8 everywhere else.
  await expect(panel.locator('[data-stat="CODEC"]')).toHaveText(/^(VP8|H264)$/);
  await expect(panel.locator('[data-stat="RESOLUÇÃO"]')).toHaveText(/^\d+×\d+$/);
  await expect(panel.locator('[data-stat="BITRATE"]')).toHaveText(/^[1-9]\d* KBPS$/);
  await expect(panel.locator('[data-stat="FPS"]')).toHaveText(/^[1-9]\d*$/);

  // A large tile asks for the top simulcast layer.
  await expect
    .poll(
      async () =>
        (await peerNamed(request, channel, 'Carla'))?.consumers.find((c) => c.source === 'screen')
          ?.preferredSpatialLayer,
    )
    .toBe(2);

  // The second stream takes the main area when Carla starts watching it. A click on the
  // first, now a thumbnail, swaps them: the second is then served from the lowest layer.
  await carla.getByRole('button', { name: 'Assistir Bruno' }).click();
  await expect(stream(carla, 'Bruno')).toBeVisible();
  await expect.poll(() => videoWidth(carla, 'Bruno')).toBeGreaterThan(0);
  await carla.getByRole('button', { name: 'Focar na transmissão de Alice' }).click();
  await expect
    .poll(async () => {
      const consumers = (await peerNamed(request, channel, 'Carla'))?.consumers ?? [];
      return [
        consumers.find((c) => c.producerId === aliceScreen?.id)?.preferredSpatialLayer,
        consumers.find((c) => c.producerId === brunoScreen?.id)?.preferredSpatialLayer,
      ];
    })
    .toEqual([2, 0]);

  // Stop watching: the consumer is closed on the server, not just hidden.
  await carla.getByRole('button', { name: 'Parar de assistir Bruno' }).click();
  await expect(stream(carla, 'Bruno')).toHaveCount(0);
  await expect
    .poll(async () =>
      (await peerNamed(request, channel, 'Carla'))?.consumers
        .filter((consumer) => consumer.source === 'screen')
        .map((consumer) => consumer.producerId),
    )
    .toEqual([aliceScreen?.id]);

  // The streamer stops: viewers lose the tile and the producer is gone.
  await alice.getByRole('button', { name: 'PARAR TRANSMISSÃO' }).first().click();
  await expect(stream(carla, 'Alice')).toHaveCount(0);
  await expect(carla.locator('[data-testid="participant"][data-live="true"]')).toHaveCount(1);
  await expect
    .poll(async () => (await peerNamed(request, channel, 'Alice'))?.producers.map((p) => p.source))
    .toEqual(['mic']);

  for (const page of [alice, bruno, carla]) await page.context().close();
});
