import { expect, test, type Page } from '@playwright/test';

async function join(page: Page, room: string, nickname: string): Promise<void> {
  await page.goto(`/lab/p2p?sala=${room}`);
  await page.getByLabel('APELIDO').fill(nickname);
  await page.getByRole('button', { name: 'ENTRAR' }).click();
}

/** Bytes of decoded remote media, read from the page's own video element. */
async function remoteMedia(page: Page) {
  return page.getByTestId('p2p-remote-video').evaluate((element) => {
    const video = element as HTMLVideoElement;
    const stream = video.srcObject as MediaStream | null;
    return {
      width: video.videoWidth,
      currentTime: video.currentTime,
      audioTracks: stream?.getAudioTracks().filter((track) => track.readyState === 'live').length,
      videoTracks: stream?.getVideoTracks().filter((track) => track.readyState === 'live').length,
    };
  });
}

test('two browsers see and hear each other over a direct connection', async ({ browser }) => {
  const room = `e2e-${Date.now()}`;
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const alice = await aliceContext.newPage();
  const bob = await bobContext.newPage();

  await join(alice, room, 'Alice');
  await expect(alice.getByTestId('p2p-status')).toHaveText('AGUARDANDO PAR');

  await join(bob, room, 'Bob');

  for (const page of [alice, bob]) {
    await expect(page.getByTestId('p2p-status')).toHaveText('EM CHAMADA');
    await expect(page.getByTestId('p2p-ice')).toHaveText(/connected|completed/);
    await expect
      .poll(async () => (await remoteMedia(page)).width, { message: 'remote video decodes' })
      .toBeGreaterThan(0);
  }

  const seenByAlice = await remoteMedia(alice);
  expect(seenByAlice.audioTracks).toBe(1);
  expect(seenByAlice.videoTracks).toBe(1);
  await expect(alice.getByText('Bob', { exact: true })).toBeVisible();
  await expect(bob.getByText('Alice', { exact: true })).toBeVisible();

  // Remote playback keeps advancing: media is actually flowing.
  const before = (await remoteMedia(bob)).currentTime;
  await expect.poll(async () => (await remoteMedia(bob)).currentTime).toBeGreaterThan(before);

  // Leaving puts the other side back in the waiting state.
  await bob.getByRole('button', { name: 'SAIR' }).click();
  await expect(alice.getByTestId('p2p-status')).toHaveText('AGUARDANDO PAR');

  await aliceContext.close();
  await bobContext.close();
});

test('a third browser is told the room is full', async ({ browser }) => {
  const room = `e2e-full-${Date.now()}`;
  const contexts = await Promise.all([1, 2, 3].map(() => browser.newContext()));
  const [alice, bob, carol] = await Promise.all(contexts.map((context) => context.newPage()));
  if (!alice || !bob || !carol) throw new Error('failed to open pages');

  await join(alice, room, 'Alice');
  await expect(alice.getByTestId('p2p-status')).toHaveText('AGUARDANDO PAR');
  await join(bob, room, 'Bob');
  await expect(bob.getByTestId('p2p-status')).toHaveText('EM CHAMADA');

  await join(carol, room, 'Carol');
  await expect(carol.getByRole('alert')).toHaveText('Esta sala já tem duas pessoas.');

  await Promise.all(contexts.map((context) => context.close()));
});
