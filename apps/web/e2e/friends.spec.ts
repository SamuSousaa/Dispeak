import { expect, test, type Browser, type Page } from '@playwright/test';

const unique = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await context.newPage();
  const username = unique(displayName.toLowerCase());
  await page.goto('/register');
  await page.getByLabel('USUÁRIO').fill(username);
  await page.getByLabel('NOME DE EXIBIÇÃO').fill(displayName);
  await page.getByLabel('SENHA').fill('correct horse battery');
  await page.getByRole('button', { name: 'CRIAR CONTA' }).click();
  await expect(page.getByTestId('gateway-status')).toHaveText('CONECTADO');
  return { page, context, username };
}

const home = (page: Page) => page.getByTestId('home-link');
const conversations = (page: Page) => page.getByTestId('conversation');

test('friends: a request, a private conversation, a call and the end of it', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const alice = await register(browser, 'Alice');
  const bruno = await register(browser, 'Bruno');

  // --- Alice asks by username; a name nobody uses is explained ------------------------------
  await home(alice.page).click();
  await expect(alice.page.getByTestId('channel-title')).toHaveText('AMIGOS');
  const field = alice.page.getByLabel('Nome de usuário do amigo');
  await field.fill('ninguem.com.esse.nome');
  await alice.page.getByRole('button', { name: 'ENVIAR PEDIDO' }).click();
  await expect(alice.page.getByRole('alert')).toContainText('Ninguém usa o nome');
  await field.fill(`@${bruno.username}`);
  await alice.page.getByRole('button', { name: 'ENVIAR PEDIDO' }).click();
  await expect(alice.page.getByRole('status').filter({ hasText: 'Pedido enviado' })).toBeVisible();
  await expect(alice.page.getByTestId('friend-request')).toContainText('aguardando resposta');

  // --- Bruno is told without reloading, and accepts ------------------------------------------
  await expect(home(bruno.page)).toHaveAttribute('data-unread', 'true');
  await home(bruno.page).click();
  await expect(bruno.page.getByTestId('friend-request')).toContainText('quer ser seu amigo');
  await bruno.page.getByRole('button', { name: 'ACEITAR' }).click();
  await expect(bruno.page.getByTestId('friend-request')).toHaveCount(0);
  await expect(bruno.page.getByTestId('friend')).toContainText('Alice');
  await expect(home(bruno.page)).toHaveAttribute('data-unread', 'false');

  // --- the conversation shows up for both, outside the list of servers -----------------------
  await expect(conversations(alice.page)).toContainText('Bruno');
  await expect(alice.page.getByTestId('friend-request')).toHaveCount(0);
  await expect(
    alice.page.getByRole('navigation', { name: 'Servidores' }).getByRole('link'),
  ).toHaveCount(1);
  await conversations(alice.page).click();
  await expect(alice.page.getByTestId('channel-title')).toHaveText('Bruno');
  const composer = alice.page.getByRole('textbox', { name: /^Mensagem/ });
  await composer.fill('oi Bruno, só nós dois aqui');
  await composer.press('Enter');
  await expect(alice.page.getByTestId('message').last()).toContainText('só nós dois aqui');

  // Bruno, still on the friends list, sees the count and then the message.
  await expect(bruno.page.getByTestId('conversation-unread')).toHaveText('1');
  await conversations(bruno.page).click();
  await expect(bruno.page.getByTestId('message').last()).toContainText('só nós dois aqui');
  await expect(bruno.page.getByTestId('conversation-unread')).toHaveCount(0);

  // --- a call inside the conversation ---------------------------------------------------------
  await alice.page.getByRole('button', { name: 'CHAMADA', exact: true }).click();
  await alice.page.getByRole('button', { name: 'LIGAR', exact: true }).click();
  await expect(alice.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(conversations(bruno.page)).toContainText('EM CHAMADA');
  // The call rings for Bruno wherever he is. Refused, it stays quiet until the next one.
  const ring = bruno.page.getByTestId('incoming-call');
  await expect(ring).toContainText('Alice');
  await ring.getByRole('button', { name: 'RECUSAR' }).click();
  await expect(ring).toHaveCount(0);
  await alice.page.getByRole('button', { name: 'Desligar voz' }).first().click();
  await expect(conversations(bruno.page)).not.toContainText('EM CHAMADA');
  await alice.page.getByRole('button', { name: 'LIGAR', exact: true }).click();
  await expect(alice.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  // Answering takes him into the call.
  await ring.getByRole('button', { name: 'ATENDER' }).click();
  await expect(ring).toHaveCount(0);
  await expect(bruno.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(alice.page.getByTestId('participant')).toHaveCount(2);
  // Nothing in a conversation is there to be moderated.
  await alice.page
    .getByTestId('participant')
    .filter({ hasText: 'Bruno' })
    .click({ button: 'right' });
  await expect(alice.page.getByTestId('context-menu')).toContainText('VOLUME PARA MIM');
  await expect(
    alice.page.getByRole('menuitem', { name: /Mutar no servidor|Expulsar|Banir|Desconectar/ }),
  ).toHaveCount(0);
  await alice.page.keyboard.press('Escape');
  await alice.page.getByRole('button', { name: 'Desligar voz' }).first().click();
  await bruno.page.getByRole('button', { name: 'Desligar voz' }).first().click();

  // --- undoing the friendship takes the conversation away from both --------------------------
  await home(alice.page).click();
  await alice.page.getByTestId('friend').getByRole('button', { name: 'REMOVER' }).click();
  await alice.page.getByRole('menuitem', { name: 'Sim, e apagar a conversa' }).click();
  await expect(alice.page.getByTestId('friend')).toHaveCount(0);
  await expect(conversations(bruno.page)).toHaveCount(0);
  await expect(bruno.page.getByTestId('channel-title')).toHaveText('AMIGOS');

  for (const { context } of [alice, bruno]) await context.close();
});
