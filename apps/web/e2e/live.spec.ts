import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

async function signUp(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const username = `${displayName.toLowerCase()}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const response = await context.request.post('/api/auth/register', {
    data: { username, displayName, password: 'correct horse battery' },
  });
  const { accessToken } = (await response.json()) as { accessToken: string };
  const post = async (path: string, data?: unknown) => {
    const result = await context.request.post(`/api${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data,
    });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return result.status() === 204 ? null : result.json();
  };
  return { context, page: await context.newPage(), post };
}

const channels = (page: Page) => page.getByRole('navigation', { name: 'Canais' });

/** The participant tiles must each have a real size and never sit on top of one another. */
async function expectTilesApart(page: Page, count: number, sideBySide = true) {
  const tiles = page.getByTestId('participant-grid').getByTestId('participant');
  await expect(tiles).toHaveCount(count);
  await expect
    .poll(async () => {
      const boxes = await Promise.all(
        Array.from({ length: count }, (_, index) => tiles.nth(index).boundingBox()),
      );
      if (boxes.some((box) => !box || box.width < 120 || box.height < 60)) return 'too small';
      for (const [index, a] of boxes.entries()) {
        for (const b of boxes.slice(index + 1)) {
          if (!a || !b) continue;
          const apart =
            a.x + a.width <= b.x + 1 ||
            b.x + b.width <= a.x + 1 ||
            a.y + a.height <= b.y + 1 ||
            b.y + b.height <= a.y + 1;
          if (!apart) return 'overlapping';
        }
      }
      // On a desktop window two people sit side by side, not one above the other.
      const [first, second] = boxes;
      if (sideBySide && first && second && Math.abs(first.y - second.y) > 1) return 'stacked';
      return 'apart';
    })
    .toBe('apart');
}

/**
 * Highest level the meter shows over a few seconds. The synthetic microphone is a short beep
 * once a second, so it has to be sampled often: a slow poll lands in the silence every time.
 */
async function peakLevel(meter: Locator): Promise<number> {
  let peak = 0;
  for (let sample = 0; sample < 50 && peak === 0; sample += 1) {
    peak = Math.max(peak, Number(await meter.getAttribute('aria-valuenow')));
    await meter.page().waitForTimeout(90);
  }
  return peak;
}

test('watching from the sidebar, layouts, an enlarged camera and a microphone meter', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const alice = await signUp(browser, 'Alice');
  const bruno = await signUp(browser, 'Bruno');
  const guild = (await alice.post('/guilds', { name: 'Ao vivo' })) as {
    id: string;
    channels: Array<{ id: string; type: string }>;
  };
  const text = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
  const invite = (await alice.post(`/guilds/${guild.id}/invites`, {})) as { code: string };
  await bruno.post(`/invites/${invite.code}/accept`);

  for (const { page } of [alice, bruno]) {
    await page.goto(`/app/${guild.id}/${text}`);
    await channels(page).getByRole('link', { name: /Geral/ }).click();
    await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  }
  await expectTilesApart(alice.page, 2);
  await expectTilesApart(bruno.page, 2);

  // --- the meter moves with what is being sent, and goes flat when muted ----------------------
  // It lives in the quick settings behind the arrow next to the microphone button, with the
  // device and the volume.
  await alice.page.getByRole('button', { name: 'Opções de entrada' }).click();
  const quick = alice.page.getByTestId('quick-audio-input');
  await expect(quick.getByLabel('VOLUME DE ENTRADA')).toHaveValue('1');
  const meter = quick.getByTestId('mic-level');
  await expect(meter).toBeVisible();
  expect(await peakLevel(meter)).toBeGreaterThan(0);
  await alice.page.getByRole('button', { name: 'Mutar microfone' }).first().click();
  await expect(meter).toHaveAttribute('aria-valuenow', '0');
  await alice.page.getByRole('button', { name: 'Ativar microfone' }).first().click();
  await alice.page.keyboard.press('Escape');
  await expect(quick).toHaveCount(0);

  // The arrow next to the headphones: the volume of everything heard in the call.
  await alice.page.getByRole('button', { name: 'Opções de saída' }).click();
  await expect(
    alice.page.getByTestId('quick-audio-output').getByLabel('VOLUME DE SAÍDA'),
  ).toHaveValue('1');
  await alice.page.keyboard.press('Escape');

  // --- Bruno goes live; Alice, reading a chat, double-clicks AO VIVO next to his name ---------
  await bruno.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await bruno.page.getByRole('menuitem').first().click();
  await expect(bruno.page.locator('[data-stream="self"]')).toBeVisible();

  await channels(alice.page).getByRole('link', { name: /geral/ }).click();
  const live = channels(alice.page).getByTestId('watch-live');
  await expect(live).toHaveCount(1);
  // One click does nothing (and does not open the person's menu either).
  await live.click();
  await expect(alice.page.getByTestId('context-menu')).toHaveCount(0);
  await expect(alice.page.locator('[data-stream="Bruno"]')).toHaveCount(0);
  await live.dblclick();
  const watched = alice.page.locator('[data-stream="Bruno"]');
  await expect(watched).toBeVisible();
  await expect
    .poll(() =>
      watched.getByTestId('stream-video').evaluate((video: HTMLVideoElement) => video.videoWidth),
    )
    .toBeGreaterThan(0);
  // --- the sound of the stream has its own volume, for this viewer only ----------------------
  await watched.hover();
  const volume = watched.getByTestId('stream-volume');
  await expect(volume).toContainText('100%');
  await volume.getByRole('slider').fill('0.4');
  await expect(volume).toContainText('40%');
  await volume.getByRole('button', { name: 'Silenciar transmissão' }).click();
  await expect(volume).toContainText('MUDO');
  // Turning it back on returns to where it was, not to full blast.
  await volume.getByRole('button', { name: 'Ativar som da transmissão' }).click();
  await expect(volume).toContainText('40%');
  // The same is on the right click, with the rest of what can be done with the stream.
  await watched.getByTestId('stream-video').click({ button: 'right' });
  const menu = alice.page.getByTestId('context-menu');
  await expect(menu.getByRole('menuitem', { name: 'Mutar transmissão' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Parar de assistir' })).toBeVisible();
  await alice.page.keyboard.press('Escape');

  // --- he stops and shares again: the stream comes back by itself, the sound as she left it --
  const own = bruno.page.locator('[data-stream="self"]');
  await own.hover();
  await own.getByRole('button', { name: 'Parar transmissão' }).click();
  await expect(watched).toHaveAttribute('data-ended', 'true');
  await expect(watched).toContainText('TRANSMISSÃO ENCERRADA');
  await bruno.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await bruno.page.getByRole('menuitem').first().click();
  await expect(watched).not.toHaveAttribute('data-ended');
  await expect
    .poll(() =>
      watched.getByTestId('stream-video').evaluate((video: HTMLVideoElement) => video.videoWidth),
    )
    .toBeGreaterThan(0);
  await watched.hover();
  await expect(volume).toContainText('40%');

  // --- clicks pick the layout: one on the stream in the main area and everyone is equal ------
  const everyone = alice.page.getByTestId('participant-grid');
  await expect(everyone).toHaveCount(0);
  await watched.getByTestId('stream-video').click();
  await expect(everyone.getByTestId('participant')).toHaveCount(2);
  await expect(everyone.getByTestId('stream-tile')).toHaveCount(1);
  await expect
    .poll(async () => {
      const [stream, person] = await Promise.all([
        everyone.getByTestId('stream-tile').boundingBox(),
        everyone.getByTestId('participant').first().boundingBox(),
      ]);
      return Math.abs((stream?.width ?? 0) - (person?.width ?? -99)) <= 2;
    })
    .toBe(true);
  // A click on the stream gives it the main area again.
  await everyone.getByTestId('stream-video').click();
  await expect(everyone).toHaveCount(0);
  await expect(watched).toBeVisible();

  // --- a person in the strip takes the main area with a click, camera on or not --------------
  await bruno.page.getByRole('button', { name: 'Ligar câmera' }).click();
  const brunoTile = alice.page.getByTestId('participant').filter({ hasText: 'Bruno' });
  await expect(brunoTile.getByTestId('camera-video')).toBeVisible();
  const small = await brunoTile.boundingBox();
  await alice.page.getByRole('button', { name: 'Destacar Bruno' }).click();
  await expect(brunoTile).toHaveAttribute('data-focused', 'true');
  await expect
    .poll(async () => (await brunoTile.boundingBox())?.height ?? 0)
    .toBeGreaterThan((small?.height ?? 0) * 3);
  // The stream he is also sharing waits in the strip as a thumbnail.
  await expect(
    alice.page.getByRole('button', { name: 'Focar na transmissão de Bruno' }),
  ).toBeVisible();
  await brunoTile.hover();
  await expect(brunoTile.getByRole('button', { name: 'Tela cheia' })).toBeVisible();
  await brunoTile.getByRole('button', { name: 'Voltar à grade' }).click();
  await expect(brunoTile).toHaveAttribute('data-focused', 'false');
  await expect(everyone.getByTestId('participant')).toHaveCount(2);
  // He keeps the main area when the camera goes off; the thumbnail swaps the stream back in.
  await alice.page.getByRole('button', { name: 'Destacar Bruno' }).click();
  await expect(brunoTile).toHaveAttribute('data-focused', 'true');
  await bruno.page.getByRole('button', { name: 'Desligar câmera' }).click();
  await expect(brunoTile.getByTestId('camera-video')).toHaveCount(0);
  await expect(brunoTile).toHaveAttribute('data-focused', 'true');
  await alice.page.getByRole('button', { name: 'Focar na transmissão de Bruno' }).click();
  await expect(brunoTile).toHaveAttribute('data-focused', 'false');
  await expect(watched).toBeVisible();
  await watched.hover();

  // --- back from the stream, the tiles are laid out again -------------------------------------
  await watched.getByRole('button', { name: 'PARAR DE ASSISTIR' }).click();
  await expectTilesApart(alice.page, 2);
  // The area changed while the grid was away (a chat opened next to the call): the
  // narrow column that is left may stack them, but each keeps its own place.
  await alice.page.getByRole('button', { name: /chat/i }).first().click();
  await expectTilesApart(alice.page, 2, false);

  // --- from outside the call, the same double click joins and watches --------------------------
  await alice.page.getByRole('button', { name: 'Desligar voz' }).first().click();
  await channels(alice.page).getByRole('link', { name: /geral/ }).click();
  await channels(alice.page).getByTestId('watch-live').dblclick();
  await expect(alice.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(alice.page.locator('[data-stream="Bruno"]')).toBeVisible();
});
