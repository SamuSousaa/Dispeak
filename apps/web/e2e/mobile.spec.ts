import { expect, test, type Browser, type Page } from '@playwright/test';

const PHONE = { width: 390, height: 844 };

async function signUp(browser: Browser, displayName: string, phone: boolean) {
  const context = await browser.newContext(
    phone
      ? { viewport: PHONE, hasTouch: true, isMobile: true }
      : { viewport: { width: 1280, height: 800 } },
  );
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

/** Nothing may be wider than the screen, or the whole app scrolls sideways under the finger. */
async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const shell = document.querySelector('#root > div');
    return {
      page: root.scrollWidth - window.innerWidth,
      scrolled: root.scrollLeft + (shell?.scrollLeft ?? 0),
    };
  });
  expect(overflow).toEqual({ page: 0, scrolled: 0 });
}

test('on a phone: drawers, full-screen dialogs and a call that stays at hand', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const alice = await signUp(browser, 'Alice', true);
  const bruno = await signUp(browser, 'Bruno', false);
  const guild = (await alice.post('/guilds', { name: 'No bolso' })) as {
    id: string;
    channels: Array<{ id: string; type: string }>;
  };
  const text = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
  const invite = (await alice.post(`/guilds/${guild.id}/invites`, {})) as { code: string };
  await bruno.post(`/invites/${invite.code}/accept`);
  await bruno.post(`/channels/${text}/messages`, { content: 'chegou no celular?' });

  const { page } = alice;
  await page.goto(`/app/${guild.id}/${text}`);
  await expect(page.getByTestId('message')).toHaveCount(1);
  await expectNoSidewaysScroll(page);
  // The side panels are drawers: out of the way until asked for.
  const channels = page.getByRole('navigation', { name: 'Canais' });
  await expect(channels).not.toBeInViewport();
  await expect(page.getByTestId('member').first()).not.toBeInViewport();

  // --- channel drawer, and a settings dialog that takes the whole screen ----------------------
  await page.getByRole('button', { name: '[ CANAIS ]' }).click();
  await expect(channels).toBeInViewport();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // Once it has slid into place.
  await expect
    .poll(async () => {
      const box = await dialog.boundingBox();
      return box && [box.x, box.y, box.width, box.height].map(Math.round);
    })
    .toEqual([0, 0, PHONE.width, PHONE.height]);
  await dialog.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expectNoSidewaysScroll(page);

  // --- a person's menu is a sheet at the bottom ----------------------------------------------
  await page.getByRole('button', { name: 'Fechar painel' }).click({ position: { x: 375, y: 300 } });
  await page.getByRole('button', { name: '[ MEMBROS ]' }).click();
  await page.getByTestId('member').filter({ hasText: 'Bruno' }).click();
  const sheet = page.getByTestId('context-menu');
  await expect(sheet.getByTestId('profile-card')).toBeVisible();
  const sheetBox = await sheet.boundingBox();
  expect(sheetBox?.x).toBeLessThanOrEqual(8);
  expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeGreaterThan(PHONE.height - 12);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Fechar painel' }).click({ position: { x: 15, y: 300 } });
  // Focus was inside the drawer that just closed; the app must not have slid after it.
  await expectNoSidewaysScroll(page);

  // --- a call: big buttons, and a strip that follows the user into the chat -------------------
  await page.getByRole('button', { name: '[ CANAIS ]' }).click();
  await channels.getByRole('link', { name: /Geral/ }).click();
  await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(page.getByTestId('participant')).toHaveCount(1);
  await expect(page.getByTestId('mobile-voice-bar')).toHaveCount(0);
  const mute = page.getByRole('main').getByRole('button', { name: 'Mutar microfone' });
  expect((await mute.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectNoSidewaysScroll(page);

  await page.getByRole('button', { name: '[ CANAIS ]' }).click();
  await channels.getByRole('link', { name: /geral/ }).click();
  const bar = page.getByTestId('mobile-voice-bar');
  await expect(bar).toContainText('EM CHAMADA');
  await bar.getByRole('button', { name: 'Mutar microfone' }).click();
  await expect(bar.getByRole('button', { name: 'Ativar microfone' })).toBeVisible();
  // Tapping the strip goes back to the call; hanging up from it ends the call.
  await bar.getByRole('link').click();
  await expect(page.getByTestId('participant')).toHaveCount(1);
  await page.getByRole('main').getByRole('button', { name: 'Desligar voz' }).click();
  await expect(page.getByRole('button', { name: 'ENTRAR NO CANAL' })).toBeVisible();
  await expectNoSidewaysScroll(page);
});
