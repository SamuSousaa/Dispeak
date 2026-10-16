import { expect, test, type Browser } from '@playwright/test';

const unique = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function register(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const page = await context.newPage();
  await page.goto('/register');
  await page.getByLabel('USUÁRIO').fill(unique(displayName.toLowerCase()));
  await page.getByLabel('NOME DE EXIBIÇÃO').fill(displayName);
  await page.getByLabel('SENHA').fill('correct horse battery');
  await page.getByRole('button', { name: 'CRIAR CONTA' }).click();
  await expect(page.getByTestId('gateway-status')).toHaveText('CONECTADO');
  return { page, context };
}

test('meetings: a link, a guest at the door, the call and its chat, the end of it', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const host = await register(browser, 'Helena');
  const shot = (page: typeof host.page, name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

  // --- the host starts one from the rail and is in the call straight away --------------------
  await host.page.getByTestId('new-meeting').click();
  await expect(host.page).toHaveURL(/\/reuniao\/[A-Za-z0-9_-]{22}$/);
  await expect(host.page.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(host.page.getByTestId('meeting-count')).toHaveText('1 NA CHAMADA');
  await expect(host.page.getByRole('button', { name: 'ENCERRAR PARA TODOS' })).toBeVisible();
  const link = host.page.url();

  // --- a guest with no account asks with a name and waits ------------------------------------
  const guestContext = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const guest = await guestContext.newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading')).toHaveText('REUNIÃO DE HELENA');
  await guest.getByLabel('SEU NOME').fill('Visitante');
  await shot(guest, '1-porta');
  await guest.getByRole('button', { name: 'PEDIR PARA ENTRAR' }).click();
  await expect(guest.getByRole('status')).toContainText('ESPERANDO ALGUÉM DEIXAR VOCÊ ENTRAR');

  // --- the host sees the knock and lets them in ----------------------------------------------
  const knock = host.page.getByTestId('knock');
  await expect(knock).toContainText('Visitante');
  await expect(knock).toContainText('CONVIDADO');
  await expect(host.page.getByText('Visitante está pedindo para entrar.')).toBeVisible();
  await shot(host.page, '2-pedido');
  await knock.getByRole('button', { name: 'ADMITIR' }).click();
  await expect(knock).toHaveCount(0);
  await expect(guest.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(host.page.getByTestId('meeting-count')).toHaveText('2 NA CHAMADA');
  await expect(host.page.getByTestId('participant')).toHaveCount(2);
  // The guest is no host: nothing to end.
  await expect(guest.getByRole('button', { name: 'ENCERRAR PARA TODOS' })).toHaveCount(0);

  // --- the chat ------------------------------------------------------------------------------
  const field = guest.getByLabel('Mensagem para a reunião');
  await field.fill('oi, cheguei');
  await field.press('Enter');
  await expect(host.page.getByTestId('meeting-message').last()).toContainText('oi, cheguei');
  await expect(host.page.getByTestId('meeting-message').last()).toContainText('Visitante');

  // --- a reload keeps the guest inside without asking again ----------------------------------
  await guest.reload();
  await expect(guest.getByTestId('voice-status')).toHaveText('CONECTADO');
  await expect(guest.getByTestId('meeting-message').last()).toContainText('oi, cheguei');
  await shot(host.page, '3-reuniao');

  // --- the host mutes the guest for everyone, and gives the microphone back -----------------
  const guestTile = host.page.getByTestId('participant').filter({ hasText: 'Visitante' });
  await guestTile.click({ button: 'right' });
  await expect(host.page.getByRole('slider')).toBeVisible();
  await host.page.getByRole('menuitem', { name: 'Mutar para todos' }).click();
  await expect(guest.getByTestId('mic-status')).toHaveText(
    'MUTADO PELO ANFITRIÃO — SOMENTE ESCUTA',
  );
  await expect(guestTile).toContainText('MUTADO PELO ANFITRIÃO');
  await shot(host.page, '5-mutado');

  // The guest may turn the host down for themselves, and nothing more.
  await guest.getByTestId('participant').filter({ hasText: 'Helena' }).click({ button: 'right' });
  await expect(guest.getByRole('menuitem', { name: 'Silenciar para mim' })).toBeVisible();
  await expect(
    guest.getByRole('menuitem', { name: /Mutar para todos|Remover da reunião/ }),
  ).toHaveCount(0);
  await shot(guest, '6-menu-convidado');
  await guest.keyboard.press('Escape');

  await host.page.getByRole('button', { name: 'Opções de Visitante' }).click();
  await host.page.getByRole('menuitem', { name: 'Devolver o microfone' }).click();
  await expect(guest.getByTestId('mic-status')).toHaveCount(0);
  await expect(guestTile).not.toContainText('MUTADO');

  // --- the host takes the guest out ----------------------------------------------------------
  await host.page.getByRole('button', { name: 'Opções de Visitante' }).click();
  await host.page.getByRole('menuitem', { name: 'Remover da reunião' }).click();
  await host.page.getByRole('menuitem', { name: 'Sim, remover' }).click();
  await expect(guest.getByRole('heading')).toHaveText('VOCÊ FOI REMOVIDO');
  await expect(host.page.getByTestId('meeting-count')).toHaveText('1 NA CHAMADA');

  // --- the host ends it; the link leads nowhere after ------------------------------------------
  await host.page.getByRole('button', { name: 'ENCERRAR PARA TODOS' }).click();
  await host.page.getByRole('button', { name: 'CONFIRMAR: ENCERRAR' }).click();
  await expect(host.page.getByRole('heading')).toHaveText('REUNIÃO ENCERRADA');
  await shot(host.page, '4-encerrada');
  await guest.goto(link);
  await expect(guest.getByRole('heading')).toHaveText('REUNIÃO ENCERRADA');

  await guestContext.close();
  await host.context.close();
});
