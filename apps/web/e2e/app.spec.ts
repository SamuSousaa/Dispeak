import { expect, test, type Browser, type Page } from '@playwright/test';

const unique = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function registerAt(page: Page, username: string, displayName: string): Promise<void> {
  await page.getByLabel('USUÁRIO').fill(username);
  await page.getByLabel('NOME DE EXIBIÇÃO').fill(displayName);
  await page.getByLabel('SENHA').fill('correct horse battery');
  await page.getByRole('button', { name: 'CRIAR CONTA' }).click();
}

async function newUser(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await context.newPage();
  const username = unique(displayName.toLowerCase());
  return { page, context, username, displayName };
}

const dialog = (page: Page) => page.getByRole('dialog');
const voiceMembers = (page: Page) => page.getByTestId('voice-member');
const stream = (page: Page, name: string) => page.locator(`[data-stream="${name}"]`);

async function joinVoice(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Canais' })
    .getByRole('link', { name: /Geral/ })
    .click();
  // Clicking a voice channel joins it.
  await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
}

test('account → server → invite → voice channel → stream, with permissions enforced', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const alice = await newUser(browser, 'Alice');
  const bruno = await newUser(browser, 'Bruno');

  // --- Alice creates an account ------------------------------------------------------------
  await alice.page.goto('/');
  await expect(alice.page).toHaveURL(/\/login/);
  await alice.page.getByRole('link', { name: 'CRIAR CONTA' }).click();
  await registerAt(alice.page, alice.username, 'Alice');
  await expect(alice.page.getByRole('heading', { name: 'Nenhum servidor ainda' })).toBeVisible();
  await expect(alice.page.getByTestId('gateway-status')).toHaveText('CONECTADO');

  // --- and a server -------------------------------------------------------------------------
  await alice.page.getByRole('button', { name: 'CRIAR OU ENTRAR', exact: true }).click();
  await dialog(alice.page).getByLabel('NOME DO SERVIDOR').fill('Amigos do e2e');
  await dialog(alice.page).getByRole('button', { name: 'CRIAR SERVIDOR' }).click();
  await expect(alice.page.getByRole('heading', { name: 'Amigos do e2e' })).toBeVisible();
  // Channels are numbered, and the text channel is opened by default.
  const channels = alice.page.getByRole('navigation', { name: 'Canais' });
  await expect(channels.getByRole('link', { name: '01. geral' })).toBeVisible();
  await expect(channels.getByRole('link', { name: /02\. Geral/ })).toBeVisible();
  await expect(alice.page.getByTestId('channel-title')).toHaveText('geral');

  // --- invites a friend ---------------------------------------------------------------------
  await alice.page.getByRole('button', { name: 'CONVIDAR' }).click();
  await dialog(alice.page).getByRole('button', { name: 'GERAR CONVITE' }).click();
  const inviteLink = await dialog(alice.page).getByTestId('invite-link').inputValue();
  expect(inviteLink).toMatch(/\/invite\/[a-zA-Z0-9]{8}$/);
  await dialog(alice.page).getByRole('button', { name: 'Fechar' }).click();

  // --- Bruno opens the link without an account, signs up and lands on the invite ------------
  await bruno.page.goto(inviteLink);
  await expect(bruno.page).toHaveURL(/\/login\?next=/);
  await bruno.page.getByRole('link', { name: 'CRIAR CONTA' }).click();
  await registerAt(bruno.page, bruno.username, 'Bruno');
  await expect(bruno.page.getByRole('heading', { name: 'Amigos do e2e' })).toBeVisible();
  await expect(bruno.page.getByText('1 MEMBRO')).toBeVisible();
  await bruno.page.getByRole('button', { name: 'ACEITAR CONVITE' }).click();
  await expect(bruno.page.getByTestId('channel-title')).toHaveText('geral');

  // Alice sees him arrive, online, without reloading.
  await expect(alice.page.getByTestId('member')).toHaveCount(2);
  await expect(
    alice.page.locator('[data-testid="member"][data-online="true"]').filter({ hasText: 'Bruno' }),
  ).toBeVisible();

  // --- both join the voice channel ----------------------------------------------------------
  await joinVoice(alice.page);
  // Bruno has not joined yet, but already sees Alice connected in the channel list.
  await expect(voiceMembers(bruno.page)).toHaveText(['Alice']);
  await joinVoice(bruno.page);

  for (const page of [alice.page, bruno.page]) {
    await expect(page.getByTestId('participant')).toHaveCount(2);
    await expect(voiceMembers(page)).toHaveCount(2);
    await expect(page.getByTestId('voice-receive')).toHaveText(/^[1-9]\d* KBPS$/);
  }

  // Mute state travels through the gateway to the channel list.
  await bruno.page.keyboard.press('m');
  await expect(voiceMembers(alice.page).filter({ hasText: 'Bruno' })).toContainText('MUDO');
  await bruno.page.keyboard.press('m');
  await expect(voiceMembers(alice.page).filter({ hasText: 'Bruno' })).not.toContainText('MUDO');

  // --- Quick settings: RNNoise is really running, and shortcuts can be rebound ---------------
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await expect(dialog(bruno.page).getByTestId('noise-active')).toHaveText('EM USO AGORA: RNNOISE');
  await dialog(bruno.page)
    .getByRole('button', { name: /^Atalho de Mutar/ })
    .click();
  await bruno.page.keyboard.press('k');
  await expect(dialog(bruno.page).getByRole('button', { name: /^Atalho de Mutar/ })).toHaveText(
    'K',
  );
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  await bruno.page.keyboard.press('m');
  await bruno.page.keyboard.press('k');
  await expect(voiceMembers(alice.page).filter({ hasText: 'Bruno' })).toContainText('MUDO');
  await bruno.page.getByRole('button', { name: 'Ativar microfone' }).click();
  await expect(voiceMembers(alice.page).filter({ hasText: 'Bruno' })).not.toContainText('MUDO');

  // --- Alice turns her camera on: Bruno sees it in her tile without asking ------------------
  const aliceCamera = bruno.page
    .getByTestId('participant')
    .filter({ hasText: 'Alice' })
    .getByTestId('camera-video');
  await alice.page.getByRole('button', { name: 'Ligar câmera' }).click();
  await expect
    .poll(() => aliceCamera.evaluate((element) => (element as HTMLVideoElement).videoWidth))
    .toBeGreaterThan(0);
  await expect(
    alice.page.getByTestId('participant').filter({ hasText: 'Alice' }).getByTestId('camera-video'),
  ).toBeVisible();
  await alice.page.getByRole('button', { name: 'Desligar câmera' }).click();
  await expect(aliceCamera).toHaveCount(0);
  // A camera is not a stream: nobody is marked as live because of it.
  await expect(voiceMembers(bruno.page).filter({ hasText: 'Alice' })).not.toContainText('AO VIVO');

  // --- Alice streams her screen; Bruno chooses to watch -------------------------------------
  await alice.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await alice.page.getByRole('menuitem', { name: /720P30/ }).click();
  await expect(voiceMembers(bruno.page).filter({ hasText: 'Alice' })).toContainText('AO VIVO');
  // The fullscreen shortcut starts watching whoever is live and takes the stream fullscreen.
  const isFullscreen = () =>
    bruno.page.evaluate(
      () => document.fullscreenElement?.getAttribute('data-testid') === 'stream-tile',
    );
  await bruno.page.keyboard.press('f');
  await expect.poll(isFullscreen).toBe(true);
  await expect
    .poll(() =>
      stream(bruno.page, 'Alice')
        .getByTestId('stream-video')
        .evaluate((element) => (element as HTMLVideoElement).videoWidth),
    )
    .toBeGreaterThan(0);

  // The same shortcut leaves fullscreen, and still works after being rebound to a chord.
  await bruno.page.keyboard.press('f');
  await expect.poll(isFullscreen).toBe(false);
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await dialog(bruno.page)
    .getByRole('button', { name: /^Atalho de Assistir transmissão em tela cheia/ })
    .click();
  await bruno.page.keyboard.press('Control+Shift+F');
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  await bruno.page.keyboard.press('Control+Shift+F');
  await expect.poll(isFullscreen).toBe(true);
  await bruno.page.keyboard.press('Control+Shift+F');
  await expect.poll(isFullscreen).toBe(false);

  // --- permissions --------------------------------------------------------------------------
  // Bruno is a regular member: no server management for him.
  await bruno.page.getByTestId('server-menu').click();
  await expect(bruno.page.getByRole('menuitem', { name: /CRIAR CANAL/ })).toHaveCount(0);
  await expect(bruno.page.getByRole('menuitem', { name: /CONFIGURAÇÕES DO SERVIDOR/ })).toHaveCount(
    0,
  );
  await bruno.page.getByRole('menuitem', { name: /OPÇÕES DO SERVIDOR/ }).click();
  await expect(dialog(bruno.page).getByRole('tab', { name: 'CARGOS' })).toHaveCount(0);
  await expect(dialog(bruno.page).getByRole('tab', { name: 'CONVITES' })).toHaveCount(0);
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(bruno.page.getByRole('button', { name: 'TRANSMITIR', exact: true })).toBeEnabled();

  // Alice forbids streaming for @everyone in this channel. Bruno's session is renewed with
  // the new rights: he stays in the call but can no longer start a stream.
  await channelsOf(alice.page)
    .getByRole('link', { name: /02\. Geral/ })
    .hover();
  await alice.page.getByRole('button', { name: 'Configurar canal Geral', exact: true }).click();
  await dialog(alice.page)
    .getByRole('radiogroup', { name: 'Transmitir tela' })
    .getByRole('radio', { name: 'NEGAR' })
    .click();
  await dialog(alice.page).getByRole('button', { name: 'Fechar' }).click();

  await expect(bruno.page.getByRole('button', { name: 'TRANSMITIR', exact: true })).toBeDisabled();
  await expect(bruno.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(bruno.page.getByTestId('participant')).toHaveCount(2);
  // The owner is unaffected and is still live.
  await expect(alice.page.getByRole('button', { name: 'PARAR TRANSMISSÃO' }).first()).toBeVisible();

  // Now she takes CONNECT away: Bruno is removed from the channel and cannot come back.
  await channelsOf(alice.page)
    .getByRole('link', { name: /02\. Geral/ })
    .hover();
  await alice.page.getByRole('button', { name: 'Configurar canal Geral', exact: true }).click();
  await dialog(alice.page)
    .getByRole('radiogroup', { name: 'Conectar' })
    .getByRole('radio', { name: 'NEGAR' })
    .click();
  await dialog(alice.page).getByRole('button', { name: 'Fechar' }).click();

  await expect(bruno.page.getByRole('alert')).toHaveText('Você foi removido do canal.');
  await expect(bruno.page.getByText('VOCÊ NÃO TEM PERMISSÃO PARA CONECTAR')).toBeVisible();
  await expect(bruno.page.getByRole('button', { name: 'ENTRAR NO CANAL' })).toBeDisabled();
  await expect(voiceMembers(alice.page)).toHaveText([/Alice/]);
  await expect(alice.page.getByTestId('participant')).toHaveCount(1);

  // --- session survives a reload (refresh cookie) and ends on logout -------------------------
  await bruno.page.reload();
  await expect(bruno.page.getByRole('heading', { name: 'Amigos do e2e' })).toBeVisible();
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await dialog(bruno.page).getByRole('button', { name: 'SAIR DA CONTA' }).click();
  await expect(bruno.page).toHaveURL(/\/login/);
  await expect(
    alice.page.locator('[data-testid="member"][data-online="false"]').filter({ hasText: 'Bruno' }),
  ).toBeVisible();

  await alice.context.close();
  await bruno.context.close();
});

function channelsOf(page: Page) {
  return page.getByRole('navigation', { name: 'Canais' });
}

test('a kicked member loses the server immediately', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await newUser(browser, 'Dona');
  const guest = await newUser(browser, 'Visita');

  await owner.page.goto('/register');
  await registerAt(owner.page, owner.username, 'Dona');
  await owner.page.getByRole('button', { name: 'CRIAR OU ENTRAR', exact: true }).click();
  await dialog(owner.page).getByLabel('NOME DO SERVIDOR').fill('Clube fechado');
  await dialog(owner.page).getByRole('button', { name: 'CRIAR SERVIDOR' }).click();
  await owner.page.getByRole('button', { name: 'CONVIDAR' }).click();
  await dialog(owner.page).getByRole('button', { name: 'GERAR CONVITE' }).click();
  const code = (await dialog(owner.page).getByTestId('invite-link').inputValue()).split('/').pop();
  await dialog(owner.page).getByRole('button', { name: 'Fechar' }).click();

  // The guest joins by pasting the code into the "join" tab.
  await guest.page.goto('/register');
  await registerAt(guest.page, guest.username, 'Visita');
  await guest.page.getByRole('button', { name: 'CRIAR OU ENTRAR', exact: true }).click();
  await dialog(guest.page).getByRole('tab', { name: 'ENTRAR COM CONVITE' }).click();
  await dialog(guest.page)
    .getByLabel('CONVITE')
    .fill(code ?? '');
  await dialog(guest.page).getByRole('button', { name: 'ENTRAR', exact: true }).click();
  await expect(guest.page.getByRole('heading', { name: 'Clube fechado' })).toBeVisible();

  // The owner creates a moderator role, assigns it, then kicks the guest.
  await owner.page.getByTestId('server-menu').click();
  await owner.page.getByRole('menuitem', { name: /CONFIGURAÇÕES DO SERVIDOR/ }).click();
  await dialog(owner.page).getByRole('tab', { name: 'CARGOS' }).click();
  await dialog(owner.page).getByLabel('Nome do novo cargo').fill('Moderador');
  await dialog(owner.page).getByRole('button', { name: '+', exact: true }).click();
  // Permission toggles are saved immediately and confirmed by the gateway.
  const manageChannels = dialog(owner.page).getByRole('checkbox', { name: /Gerenciar canais/ });
  await manageChannels.click();
  await expect(manageChannels).toBeChecked();

  await dialog(owner.page).getByRole('tab', { name: 'MEMBROS' }).click();
  const guestRow = dialog(owner.page).getByTestId('settings-member').filter({ hasText: 'Visita' });
  await guestRow.getByRole('button', { name: 'Moderador' }).click();
  // The new permission reaches the guest live: the "+ CANAL" action appears.
  await guest.page.getByTestId('server-menu').click();
  await expect(guest.page.getByRole('menuitem', { name: /CRIAR CANAL/ })).toBeVisible();
  await guest.page.keyboard.press('Escape');
  await expect(guest.page.getByTestId('member').filter({ hasText: 'Visita' })).toContainText(
    'Moderador',
  );

  await guestRow.getByRole('button', { name: 'EXPULSAR' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Nenhum servidor ainda' })).toBeVisible();
  await expect(dialog(owner.page).getByTestId('settings-member')).toHaveCount(1);

  await owner.context.close();
  await guest.context.close();
});
