import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface Session {
  context: BrowserContext;
  page: Page;
  token: string;
  userId: string;
  post: (path: string, data?: unknown) => Promise<unknown>;
}

/** Registers through the API (the browser context keeps the refresh cookie) and opens the app. */
async function signUp(browser: Browser, displayName: string): Promise<Session> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const username = `${displayName.toLowerCase()}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const response = await context.request.post('/api/auth/register', {
    data: { username, displayName, password: 'correct horse battery' },
  });
  const { accessToken, user } = (await response.json()) as {
    accessToken: string;
    user: { id: string };
  };
  const post = async (path: string, data?: unknown) => {
    const result = await context.request.post(`/api${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data,
    });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return result.status() === 204 ? null : result.json();
  };
  return { context, page: await context.newPage(), token: accessToken, userId: user.id, post };
}

const messages = (page: Page) => page.getByTestId('message');
const composer = (page: Page) => page.getByRole('textbox', { name: 'Mensagem em geral' });

test('text chat: live messages, typing, mentions, edit, delete and history', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const alice = await signUp(browser, 'Alice');
  const bruno = await signUp(browser, 'Bruno');

  const guild = (await alice.post('/guilds', { name: 'Chat e2e' })) as {
    id: string;
    channels: Array<{ id: string; type: string }>;
  };
  const channelId = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
  const invite = (await alice.post(`/guilds/${guild.id}/invites`, {})) as { code: string };
  await bruno.post(`/invites/${invite.code}/accept`);

  // History that predates both browsers: 60 messages, more than one page.
  for (let i = 1; i <= 60; i++) {
    await alice.post(`/channels/${channelId}/messages`, { content: `histórico ${i}` });
  }

  await alice.page.goto(`/app/${guild.id}/${channelId}`);
  await bruno.page.goto(`/app/${guild.id}/${channelId}`);
  for (const page of [alice.page, bruno.page]) {
    await expect(page.getByTestId('gateway-status')).toHaveText('CONECTADO');
  }

  // --- cursor pagination ----------------------------------------------------------------------
  // The newest page (50) is shown, scrolled to the latest message.
  await expect(messages(bruno.page)).toHaveCount(50);
  await expect(messages(bruno.page).last()).toContainText('histórico 60');
  await expect(messages(bruno.page).last()).toBeInViewport();
  await expect(messages(bruno.page).first()).toContainText('histórico 11');

  await bruno.page.getByRole('button', { name: 'CARREGAR ANTERIORES' }).click();
  await expect(messages(bruno.page)).toHaveCount(60);
  await expect(messages(bruno.page).first()).toContainText('histórico 1');
  await expect(bruno.page.getByText('INÍCIO DE geral')).toBeVisible();
  await expect(bruno.page.getByRole('button', { name: 'CARREGAR ANTERIORES' })).toHaveCount(0);
  // Loading older messages does not yank the reader away from where they were.
  await expect(messages(bruno.page).filter({ hasText: /histórico 11$/ })).toBeInViewport();

  // --- typing indicator -----------------------------------------------------------------------
  await composer(alice.page).pressSequentially('olá');
  await expect(bruno.page.getByTestId('typing')).toHaveText('Alice ESTÁ DIGITANDO');
  // Nobody is told about their own typing.
  await expect(alice.page.getByTestId('typing')).toHaveText('');

  // --- live delivery --------------------------------------------------------------------------
  await composer(alice.page).press('Enter');
  await expect(messages(alice.page).last()).toContainText('olá');
  await expect(messages(bruno.page).last()).toContainText('olá');
  await expect(bruno.page.getByTestId('typing')).toHaveText('');
  await expect(composer(alice.page)).toHaveValue('');

  // Shift+Enter breaks the line instead of sending.
  await composer(bruno.page).pressSequentially('linha um');
  await composer(bruno.page).press('Shift+Enter');
  await composer(bruno.page).pressSequentially('linha dois');
  await composer(bruno.page).press('Enter');
  await expect(messages(alice.page).last()).toContainText('linha um\nlinha dois');

  // --- mentions -------------------------------------------------------------------------------
  await composer(alice.page).pressSequentially('psiu @br');
  const suggestions = alice.page.getByRole('listbox', { name: 'Mencionar' });
  await expect(suggestions.getByRole('option')).toHaveText([/@Bruno/]);
  await composer(alice.page).press('Enter'); // picks the suggestion, does not send
  await expect(composer(alice.page)).toHaveValue('psiu @Bruno ');
  await composer(alice.page).pressSequentially('olha isso');
  await composer(alice.page).press('Enter');

  const mention = messages(bruno.page).last();
  await expect(mention).toContainText('psiu @Bruno olha isso');
  await expect(mention).toHaveAttribute('data-mentions-me', 'true');
  await expect(mention.locator('[data-mention]')).toHaveText('@Bruno');
  // For the author it is an ordinary message.
  await expect(messages(alice.page).last()).toHaveAttribute('data-mentions-me', 'false');

  // --- edit -----------------------------------------------------------------------------------
  const mine = messages(alice.page).last();
  await mine.hover();
  await mine.getByRole('button', { name: 'Editar mensagem' }).click();
  const editor = alice.page.getByRole('textbox', { name: 'Editar mensagem' });
  await expect(editor).toHaveValue('psiu @Bruno olha isso');
  await editor.fill('psiu @Bruno corrigido');
  await editor.press('Enter');
  await expect(messages(bruno.page).last()).toContainText('psiu @Bruno corrigido');
  await expect(messages(bruno.page).last()).toContainText('(EDITADA)');
  await expect(messages(bruno.page).last()).toHaveAttribute('data-mentions-me', 'true');

  // Bruno cannot edit or delete Alice's message.
  await messages(bruno.page).last().hover();
  await expect(messages(bruno.page).last().getByRole('button')).toHaveCount(0);

  // --- delete ---------------------------------------------------------------------------------
  const total = await messages(bruno.page).count();
  await messages(alice.page).last().hover();
  await messages(alice.page).last().getByRole('button', { name: 'Excluir mensagem' }).click();
  await messages(alice.page).last().getByRole('button', { name: 'CONFIRMAR' }).click();
  await expect(messages(bruno.page)).toHaveCount(total - 1);
  await expect(bruno.page.getByText('psiu @Bruno corrigido')).toHaveCount(0);

  // --- read-only channel ----------------------------------------------------------------------
  await alice.context.request.put(`/api/channels/${channelId}/overwrites/${guild.id}`, {
    headers: { authorization: `Bearer ${alice.token}` },
    data: { targetType: 'role', allow: '0', deny: '2' }, // SEND_MESSAGES
  });
  await expect(bruno.page.getByText('VOCÊ NÃO PODE ENVIAR MENSAGENS NESTE CANAL')).toBeVisible();
  await expect(composer(alice.page)).toBeVisible();

  await alice.context.close();
  await bruno.context.close();
});
