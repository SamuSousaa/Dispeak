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
  // Notification sounds are the only audio played from a URL (voices use srcObject): count them.
  await context.addInitScript(() => {
    // Nobody starts with shortcuts; these tests press the ones a user would have chosen.
    if (!localStorage.getItem('frequencia.settings')) {
      localStorage.setItem(
        'frequencia.settings',
        JSON.stringify({
          state: { keybinds: { mute: 'M', deafen: 'D', fullscreen: 'F' } },
          version: 4,
        }),
      );
    }
    const played: string[] = [];
    (window as unknown as { playedSounds: string[] }).playedSounds = played;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if (this.src) played.push(this.src);
      return play.call(this);
    };
  });
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
  await expect(voiceMembers(bruno.page)).toHaveText([/Alice$/]);
  await joinVoice(bruno.page);
  // One sound for Bruno joining; Alice hears him arrive.
  const sounds = (page: Page) =>
    page.evaluate(() => (window as unknown as { playedSounds: string[] }).playedSounds.length);
  await expect.poll(() => sounds(bruno.page)).toBe(1);
  await expect.poll(() => sounds(alice.page)).toBe(2);

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

  // --- Right click on a person: their volume, for this user only ---------------------------
  const brunoTile = alice.page.getByTestId('participant').filter({ hasText: 'Bruno' });
  // A plain click on the name shows the profile and nothing else.
  await voiceMembers(alice.page).filter({ hasText: 'Bruno' }).click();
  await expect(alice.page.getByTestId('context-menu').getByTestId('profile-card')).toBeVisible();
  await expect(alice.page.getByRole('menuitem')).toHaveCount(0);
  await alice.page.keyboard.press('Escape');
  await voiceMembers(alice.page).filter({ hasText: 'Bruno' }).click({ button: 'right' });
  await expect(alice.page.getByTestId('context-menu')).toContainText('VOLUME PARA MIM — 100%');
  await expect(alice.page.getByTestId('profile-card')).toHaveCount(0);
  await alice.page.getByRole('menuitem', { name: 'Silenciar para mim' }).click();
  await expect(brunoTile.getByTestId('volume-note')).toHaveText('SILENCIADO');
  await brunoTile.click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Voltar a ouvir' }).click();
  await expect(brunoTile.getByTestId('volume-note')).toHaveCount(0);

  // --- The voice channel has a chat of its own, opened next to the call ---------------------
  await alice.page.getByTestId('voice-chat-toggle').click();
  const sideChat = alice.page.getByTestId('side-chat');
  await expect(sideChat).toContainText('CHAT DE Geral');
  await sideChat.getByRole('textbox', { name: 'Mensagem em Geral' }).fill('do lado da chamada');
  await sideChat.getByRole('textbox', { name: 'Mensagem em Geral' }).press('Enter');
  await expect(sideChat.getByTestId('message').last()).toContainText('do lado da chamada');
  await expect(alice.page.getByTestId('participant')).toHaveCount(2);
  // Bruno has it closed: the button tells him something arrived, and opening it shows the message.
  await expect(bruno.page.getByTestId('voice-chat-toggle')).toContainText('1');
  await bruno.page.getByTestId('voice-chat-toggle').click();
  await expect(bruno.page.getByTestId('side-chat').getByTestId('message').last()).toContainText(
    'do lado da chamada',
  );
  await bruno.page.getByTestId('side-chat').getByRole('button', { name: 'Fechar chat' }).click();
  await sideChat.getByRole('button', { name: 'Fechar chat' }).click();
  await expect(sideChat).toHaveCount(0);

  // --- The participants share the whole stage -------------------------------------------------
  const stage = await alice.page.getByTestId('participant-grid').boundingBox();
  const tile = await alice.page.getByTestId('participant').first().boundingBox();
  // Two people side by side: each tile takes close to half of the width.
  expect((tile?.width ?? 0) * 2).toBeGreaterThan((stage?.width ?? 0) * 0.85);

  // --- Categories fold away, keeping the channel the user is in -------------------------------
  const channelList = alice.page.getByRole('navigation', { name: 'Canais' });
  await expect(channelList.getByRole('link', { name: /geral/ })).toHaveCount(1);
  await channelList.getByTestId('category-toggle').first().click();
  await expect(channelList.getByRole('link', { name: /geral/ })).toHaveCount(0);
  await channelList.getByTestId('category-toggle').last().click();
  await expect(channelList.getByRole('link', { name: /Geral/ })).toHaveCount(1);
  await channelList.getByTestId('category-toggle').first().click();
  await channelList.getByTestId('category-toggle').last().click();
  await expect(channelList.getByRole('link', { name: /geral/ })).toHaveCount(1);

  // --- Noise suppression: one switch next to the call controls, and the model really runs ----
  await bruno.page.getByTestId('noise-toggle').click();
  await expect(bruno.page.getByTestId('noise-toggle')).toHaveAttribute('aria-pressed', 'false');
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await expect(dialog(bruno.page).getByTestId('noise-active')).toHaveText(
    'EM USO AGORA: DESLIGADA',
  );
  await dialog(bruno.page)
    .getByRole('checkbox', { name: /SUPRESSÃO DE RUÍDO/ })
    .check();
  await expect(dialog(bruno.page).getByTestId('noise-active')).toHaveText('EM USO AGORA: GTCRN');
  await dialog(bruno.page).getByRole('tab', { name: 'ATALHOS' }).click();
  await dialog(bruno.page)
    .getByRole('button', { name: /^Atalho de Mutar/ })
    .click();
  await bruno.page.keyboard.press('k');
  await expect(dialog(bruno.page).getByRole('button', { name: /^Atalho de Mutar/ })).toHaveText(
    'K',
  );
  // Push-to-talk: the microphone only opens while the chosen key is held.
  await dialog(bruno.page).getByRole('tab', { name: 'VOZ' }).click();
  await dialog(bruno.page).getByText('APERTAR PARA FALAR', { exact: true }).click();
  await expect(dialog(bruno.page).getByRole('radio', { name: /APERTAR PARA FALAR/ })).toBeChecked();
  await dialog(bruno.page)
    .getByRole('button', { name: /^Atalho de Apertar para falar/ })
    .click();
  await bruno.page.keyboard.press('v');
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(bruno.page.getByTestId('ptt-status')).toHaveText('SEGURE V PARA FALAR');
  await bruno.page.keyboard.down('v');
  await expect(bruno.page.getByTestId('ptt-status')).toHaveText('TRANSMITINDO');
  await bruno.page.keyboard.up('v');
  await expect(bruno.page.getByTestId('ptt-status')).toHaveText('SEGURE V PARA FALAR');
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await dialog(bruno.page).getByText('MICROFONE ABERTO', { exact: true }).click();
  await expect(bruno.page.getByTestId('ptt-status')).toHaveCount(0);
  // A file from the computer replaces the built-in sound, and is played once to confirm.
  await dialog(bruno.page).getByRole('tab', { name: 'NOTIFICAÇÕES' }).click();
  await dialog(bruno.page)
    .getByTestId('sound-input-join')
    .setInputFiles({
      name: 'entrada.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=', 'base64'),
    });
  await expect(dialog(bruno.page).getByTestId('sound-file-join')).toHaveText(
    'ARQUIVO: entrada.wav',
  );
  await expect.poll(() => sounds(bruno.page)).toBe(2);
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

  // --- Pictures: a profile picture and a server icon, cut to a square by the browser --------
  // A 3x2 PNG, so the crop has something to do.
  const picture = {
    name: 'foto.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAGElEQVR4nGP4z8DAAMH//zMw/P//n+E/AErJCPgO3Eq0AAAAAElFTkSuQmCC',
      'base64',
    ),
  };
  const width = (image: HTMLElement) => (image as HTMLImageElement).naturalWidth;
  await bruno.page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await dialog(bruno.page).getByRole('tab', { name: 'PERFIL' }).click();
  await dialog(bruno.page).getByTestId('avatar-input').setInputFiles(picture);
  await expect(dialog(bruno.page).getByRole('button', { name: /^Remover sua foto/ })).toBeVisible();
  // The rest of the profile, on the same tab.
  await dialog(bruno.page)
    .getByLabel(/^STATUS/)
    .fill('🎮 até tarde');
  await dialog(bruno.page)
    .getByLabel(/^SOBRE MIM/)
    .fill('Jogo de tudo um pouco.');
  await dialog(bruno.page).getByRole('button', { name: 'SALVAR PERFIL' }).click();
  await expect(dialog(bruno.page).getByRole('status')).toHaveText('SALVO');
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  // Everyone sees it: in the member list, in the voice channel and on the stage.
  const brunoMember = alice.page.getByTestId('member').filter({ hasText: 'Bruno' });
  await expect.poll(() => brunoMember.locator('img').evaluate(width)).toBe(256);
  await expect(
    voiceMembers(alice.page).filter({ hasText: 'Bruno' }).getByTestId('avatar'),
  ).toHaveAttribute('data-picture', 'true');
  await expect(
    alice.page.getByTestId('participant').filter({ hasText: 'Bruno' }).getByTestId('avatar'),
  ).toHaveAttribute('data-picture', 'true');

  // --- The profile card, and how each one chooses to be seen ---------------------------------
  await expect(brunoMember.getByTestId('member-status')).toHaveText('🎮 até tarde');
  await brunoMember.click();
  const card = alice.page.getByTestId('profile-card');
  await expect(card.getByTestId('profile-status')).toHaveText('🎮 até tarde');
  await expect(card.getByTestId('profile-bio')).toHaveText('Jogo de tudo um pouco.');
  await expect(card).toContainText('DISPONÍVEL');
  await expect(card).toContainText('NO SERVIDOR DESDE');
  await alice.page.keyboard.press('Escape');

  const setStatus = async (label: string) => {
    await bruno.page.getByTestId('self-status').click();
    await bruno.page.getByRole('menuitem', { name: label }).click();
  };
  await setStatus('Não perturbe');
  await expect(brunoMember.locator('[data-presence="dnd"]')).toBeVisible();
  // Invisible: offline for everyone else, while he keeps using the app.
  await setStatus('Invisível');
  await expect(brunoMember).toHaveAttribute('data-online', 'false');
  await expect(bruno.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await setStatus('Disponível');
  await expect(brunoMember).toHaveAttribute('data-online', 'true');
  await expect(brunoMember.locator('[data-presence="online"]')).toBeVisible();

  // --- A forgotten password: the owner makes a link, and it works once -----------------------
  await brunoMember.click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Link de nova senha' }).click();
  const resetLink = await alice.page.getByTestId('link-dialog').getByLabel('Link').inputValue();
  expect(resetLink).toMatch(/\/reset\/[\w-]{20,}$/);
  await alice.page.getByRole('dialog').getByRole('button', { name: 'Fechar' }).click();
  // Someone who is not signed in anywhere opens it.
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(resetLink);
  await visitor.getByLabel(/^NOVA SENHA/).fill('senha nova do bruno');
  await visitor.getByLabel('CONFIRMAR A NOVA SENHA').fill('senha diferente');
  await visitor.getByRole('button', { name: 'TROCAR SENHA' }).click();
  await expect(visitor.getByRole('alert')).toHaveText('As duas senhas não são iguais.');
  await visitor.getByLabel('CONFIRMAR A NOVA SENHA').fill('senha nova do bruno');
  await visitor.getByRole('button', { name: 'TROCAR SENHA' }).click();
  await expect(visitor.getByRole('status')).toContainText('Senha trocada');
  // The link is spent, and Bruno's open session was closed: he signs in with the new password.
  await visitor.goto(resetLink);
  await visitor.getByLabel(/^NOVA SENHA/).fill('outra senha qualquer');
  await visitor.getByLabel('CONFIRMAR A NOVA SENHA').fill('outra senha qualquer');
  await visitor.getByRole('button', { name: 'TROCAR SENHA' }).click();
  await expect(visitor.getByRole('alert')).toContainText('Este link não vale mais');
  await visitor.context().close();
  await expect(bruno.page).toHaveURL(/\/login/);
  await bruno.page.getByLabel('USUÁRIO').fill(bruno.username);
  await bruno.page.getByLabel('SENHA').fill('senha nova do bruno');
  await bruno.page.getByRole('button', { name: 'ENTRAR', exact: true }).click();
  await expect(bruno.page.getByTestId('gateway-status')).toHaveText('CONECTADO');
  await joinVoice(bruno.page);
  await expect(alice.page.getByTestId('participant')).toHaveCount(2);

  // --- Moderation from the right-click menu: server mute, then out of the call --------------
  await brunoTile.click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Mutar no servidor' }).click();
  await expect(bruno.page.getByTestId('mic-status')).toHaveText(
    'MUTADO NO SERVIDOR — SOMENTE ESCUTA',
  );
  await expect(brunoTile).toContainText('MUTADO NO SERVIDOR');
  // Bruno has no such item in anyone's menu, his own included.
  await bruno.page
    .getByTestId('participant')
    .filter({ hasText: 'Alice' })
    .click({ button: 'right' });
  await expect(bruno.page.getByTestId('context-menu')).toContainText('VOLUME PARA MIM');
  await expect(bruno.page.getByRole('menuitem', { name: /Mutar no servidor|Banir/ })).toHaveCount(
    0,
  );
  await bruno.page.keyboard.press('Escape');
  await brunoMember.click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Devolver o microfone' }).click();
  await expect(bruno.page.getByTestId('mic-status')).toHaveCount(0);
  await expect(bruno.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(alice.page.getByTestId('participant')).toHaveCount(2);

  await brunoTile.click({ button: 'right' });
  await alice.page.getByRole('menuitem', { name: 'Desconectar da chamada' }).click();
  await expect(bruno.page.getByRole('alert')).toHaveText('Você foi removido do canal.');
  await expect(alice.page.getByTestId('participant')).toHaveCount(1);
  await bruno.page.getByRole('button', { name: 'ENTRAR NO CANAL' }).click();
  await expect(bruno.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(alice.page.getByTestId('participant')).toHaveCount(2);

  // --- The owner picks a sound for the whole server; members download and play it -----------
  await alice.page.getByTestId('server-menu').click();
  await alice.page.getByRole('menuitem', { name: /CONFIGURAÇÕES DO SERVIDOR/ }).click();
  await dialog(alice.page).getByTestId('guild-icon-input').setInputFiles(picture);
  await expect.poll(() => bruno.page.getByTestId('guild-icon').evaluate(width)).toBe(256);
  await dialog(alice.page).getByRole('tab', { name: 'SONS' }).click();
  await dialog(alice.page)
    .getByTestId('guild-sound-input-streamStart')
    .setInputFiles({
      name: 'ao-vivo.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=', 'base64'),
    });
  await expect(dialog(alice.page).getByTestId('guild-sound-streamStart')).toHaveText(
    'ARQUIVO: ao-vivo.wav',
  );
  await dialog(alice.page).getByRole('button', { name: 'Fechar' }).click();

  // --- Alice streams her screen; Bruno chooses to watch -------------------------------------
  const serverSound = bruno.page.waitForResponse(
    (response) => response.url().endsWith('/sounds/streamStart') && response.status() === 200,
  );
  await alice.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await alice.page.getByRole('menuitem', { name: /720P30/ }).click();
  await serverSound;
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
  await dialog(bruno.page).getByRole('tab', { name: 'ATALHOS' }).click();
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
  await expect(dialog(bruno.page).getByRole('tab', { name: 'SONS' })).toHaveCount(0);
  await expect(dialog(bruno.page).getByRole('tab', { name: 'CONVITES' })).toHaveCount(0);
  await dialog(bruno.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(bruno.page.getByRole('button', { name: 'TRANSMITIR', exact: true })).toBeEnabled();

  // Alice forbids streaming for @everyone in this channel. Bruno's session is renewed with
  // the new rights: he stays in the call but can no longer start a stream.
  await channelsOf(alice.page)
    .getByRole('link', { name: /02\. Geral/ })
    .hover();
  await alice.page.getByRole('button', { name: 'Configurar canal Geral', exact: true }).click();
  await dialog(alice.page).getByRole('tab', { name: 'PERMISSÕES' }).click();
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
  await dialog(alice.page).getByRole('tab', { name: 'PERMISSÕES' }).click();
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
  await dialog(bruno.page).getByRole('tab', { name: 'MINHA CONTA' }).click();
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
  // The member list groups whoever is online under their highest role.
  await expect(
    guest.page.getByTestId('member-group').filter({ hasText: 'Moderador' }).getByTestId('member'),
  ).toHaveText([/Visita$/]);

  await guestRow.getByRole('button', { name: 'EXPULSAR' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Nenhum servidor ainda' })).toBeVisible();
  await expect(dialog(owner.page).getByTestId('settings-member')).toHaveCount(1);

  await owner.context.close();
  await guest.context.close();
});
