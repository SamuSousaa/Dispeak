import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';

interface MediaStats {
  rooms: Array<{
    id: string;
    peers: Array<{
      id: string;
      name: string;
      muted: boolean;
      producers: Array<{ source: string; paused: boolean }>;
      consumers: Array<{ source: string; paused: boolean }>;
    }>;
  }>;
}

async function roomStats(request: APIRequestContext, channel: string) {
  // Outside development the endpoint asks for the secret shared with the API.
  const secret = process.env.E2E_MEDIA_SECRET;
  const response = await request.get('/media/stats', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
  const stats = (await response.json()) as MediaStats;
  return stats.rooms.find((room) => room.id === `lab:${channel}`);
}

async function join(browser: Browser, channel: string, nickname: string): Promise<Page> {
  const context = await browser.newContext();
  // The synthetic microphone beeps, and a beep is exactly what the noise suppression removes:
  // these tests are about the audio going through, so it is sent as captured.
  await context.addInitScript(() => {
    localStorage.setItem(
      'frequencia.settings',
      JSON.stringify({
        state: { noiseSuppression: false, keybinds: { mute: 'M', deafen: 'D' } },
        version: 4,
      }),
    );
  });
  const page = await context.newPage();
  await page.goto(`/lab/voice?canal=${channel}`);
  await page.getByLabel('APELIDO').fill(nickname);
  await page.getByRole('button', { name: 'ENTRAR' }).click();
  await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  return page;
}

const participant = (page: Page, name: string) =>
  page.getByTestId('participant').filter({ hasText: name });

test('four participants talk in the same voice channel through the SFU', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const channel = `e2e-${Date.now()}`;
  const names = ['Alice', 'Bruno', 'Carla', 'Diego'];
  const pages: Page[] = [];
  for (const name of names) pages.push(await join(browser, channel, name));
  const [alice, bruno] = pages as [Page, Page, Page, Page];

  // Everyone sees everyone.
  for (const page of pages) {
    await expect(page.getByTestId('participant')).toHaveCount(4);
    await expect(page.getByTestId('voice-count')).toHaveText('4');
  }

  // Server side: one microphone producer each, and each peer consumes the other three.
  await expect
    .poll(async () => {
      const room = await roomStats(request, channel);
      return room?.peers.map((peer) => [peer.producers.length, peer.consumers.length]);
    })
    .toEqual([
      [1, 3],
      [1, 3],
      [1, 3],
      [1, 3],
    ]);

  // Audio is really flowing in both directions for every participant.
  for (const page of pages) {
    await expect(page.getByTestId('voice-send')).toHaveText(/^[1-9]\d* KBPS$/);
    await expect(page.getByTestId('voice-receive')).toHaveText(/^[1-9]\d* KBPS$/);
  }

  // Speaking indicator: Chromium's synthetic microphone beeps, the AudioLevelObserver
  // reports it, and remote tiles light up.
  await expect(
    alice.locator('[data-testid="participant"][data-speaking="true"]').first(),
  ).toBeVisible();

  // Mute is enforced on the server and mirrored to the other participants.
  await alice.getByRole('button', { name: 'MUTAR' }).click();
  await expect(participant(bruno, 'Alice')).toHaveAttribute('data-muted', 'true');
  await expect
    .poll(async () => {
      const room = await roomStats(request, channel);
      return room?.peers.find((peer) => peer.name === 'Alice')?.producers[0]?.paused;
    })
    .toBe(true);
  // A muted participant is never shown as speaking.
  await expect(participant(bruno, 'Alice')).toHaveAttribute('data-speaking', 'false');

  // Keyboard shortcut: D deafens (and implies mute), pausing incoming audio on the server.
  await bruno.keyboard.press('d');
  await expect(participant(alice, 'Bruno')).toHaveAttribute('data-deafened', 'true');
  await expect
    .poll(async () => {
      const room = await roomStats(request, channel);
      return room?.peers.find((peer) => peer.name === 'Bruno')?.consumers.every((c) => c.paused);
    })
    .toBe(true);
  await bruno.keyboard.press('d');
  await expect(participant(alice, 'Bruno')).toHaveAttribute('data-deafened', 'false');

  // Leaving one by one; the last one out releases the room on the server.
  await alice.getByRole('button', { name: 'SAIR' }).click();
  await expect(bruno.getByTestId('participant')).toHaveCount(3);
  await expect.poll(async () => (await roomStats(request, channel))?.peers.length).toBe(3);

  for (const page of pages.slice(1)) await page.context().close();
  await expect.poll(async () => await roomStats(request, channel)).toBeUndefined();
  await alice.context().close();
});

test('a dropped signaling connection is re-established automatically', async ({
  browser,
  request,
}) => {
  const channel = `e2e-rc-${Date.now()}`;
  const alice = await join(browser, channel, 'Alice');

  // Bruno's page keeps track of its sockets so the test can cut the signaling one.
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const sockets: WebSocket[] = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
    };
    (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
  });
  const bruno = await context.newPage();
  await bruno.goto(`/lab/voice?canal=${channel}`);
  await bruno.getByLabel('APELIDO').fill('Bruno');
  await bruno.getByRole('button', { name: 'ENTRAR' }).click();
  await expect(bruno.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(alice.getByTestId('participant')).toHaveCount(2);

  const sessionId = async () =>
    (await roomStats(request, channel))?.peers.find((peer) => peer.name === 'Bruno')?.id;
  const before = await sessionId();
  expect(before).toBeTruthy();

  await bruno.evaluate(() => {
    const { __sockets } = window as unknown as { __sockets: WebSocket[] };
    for (const socket of __sockets) if (socket.url.includes('/media/voice')) socket.close();
  });

  // A brand new session takes over, and both sides see each other again.
  await expect.poll(sessionId).not.toBe(before);
  await expect.poll(sessionId).toBeTruthy();
  await expect(bruno.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(bruno.getByTestId('participant')).toHaveCount(2);
  await expect(alice.getByTestId('participant')).toHaveCount(2);
  await expect.poll(async () => (await roomStats(request, channel))?.peers.length).toBe(2);
  await expect(bruno.getByTestId('voice-receive')).toHaveText(/^[1-9]\d* KBPS$/);

  await alice.context().close();
  await context.close();
});
