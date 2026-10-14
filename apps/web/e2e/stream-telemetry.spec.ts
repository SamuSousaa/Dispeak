import type { StreamReport, StreamReportSummary } from '@frequencia/shared';
import { expect, test, type Browser } from '@playwright/test';

async function signUp(browser: Browser, displayName: string) {
  const context = await browser.newContext({ viewport: { width: 1360, height: 820 } });
  const username = `${displayName.toLowerCase()}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const response = await context.request.post('/api/auth/register', {
    data: { username, displayName, password: 'correct horse battery' },
  });
  const { accessToken } = (await response.json()) as { accessToken: string };
  const headers = { authorization: `Bearer ${accessToken}` };
  const post = async (path: string, data?: unknown) => {
    const result = await context.request.post(`/api${path}`, { headers, data });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return result.status() === 204 ? null : result.json();
  };
  const get = async <T>(path: string) => {
    const result = await context.request.get(`/api${path}`, { headers });
    expect(result.ok(), `${path} -> ${result.status()}`).toBe(true);
    return (await result.json()) as T;
  };
  return { context, page: await context.newPage(), post, get };
}

test('a stream is measured at the streamer, the server and the viewer', async ({ browser }) => {
  test.setTimeout(120_000);
  const ana = await signUp(browser, 'Ana');
  const bia = await signUp(browser, 'Bia');
  const guild = (await ana.post('/guilds', { name: 'Medição' })) as {
    id: string;
    channels: Array<{ id: string; type: string }>;
  };
  const text = guild.channels.find((channel) => channel.type === 'text')?.id ?? '';
  const invite = (await ana.post(`/guilds/${guild.id}/invites`, {})) as { code: string };
  await bia.post(`/invites/${invite.code}/accept`);

  for (const { page } of [ana, bia]) {
    await page.goto(`/app/${guild.id}/${text}`);
    await page
      .getByRole('navigation', { name: 'Canais' })
      .getByRole('link', { name: /Geral/ })
      .click();
    await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  }

  await ana.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
  await ana.page.getByRole('menuitem', { name: /720P30/ }).click();
  await expect(ana.page.locator('[data-stream="self"]')).toBeVisible();
  await bia.page.getByRole('button', { name: 'Assistir Ana' }).click();
  const watched = bia.page.locator('[data-stream="Ana"]');
  await expect
    .poll(() =>
      watched.getByTestId('stream-video').evaluate((video: HTMLVideoElement) => video.videoWidth),
    )
    .toBeGreaterThan(0);

  // Two whole windows of the media service, then the end of the stream sends them.
  await ana.page.waitForTimeout(11_000);
  await ana.page.getByRole('button', { name: 'PARAR TRANSMISSÃO' }).first().click();

  let summary: StreamReportSummary | undefined;
  await expect
    .poll(async () => {
      [summary] = (await ana.get<{ reports: StreamReportSummary[] }>('/stream-reports')).reports;
      return summary?.endedAt ? summary.sampleCount : 0;
    })
    .toBeGreaterThanOrEqual(2);
  expect(summary).toMatchObject({ userName: 'Ana', path: 'browser', channelName: 'Geral' });

  const report = await ana.get<StreamReport>(`/stream-reports/${summary?.id ?? ''}`);
  const [first] = report.samples;
  expect(first?.server.fps).toBeGreaterThan(5);
  expect(first?.sender).toMatchObject({ preset: '720p30' });
  expect(first?.sender?.captureFps).toBeGreaterThan(0);
  expect(first?.viewers).toHaveLength(1);
  expect(first?.viewers[0]?.fps).toBeGreaterThan(0);
  expect(report.viewerNames).toEqual({ [first?.viewers[0]?.userId ?? '']: 'Bia' });
  // Bia only watched; the stream is not hers and the server is not hers.
  expect((await bia.get<{ reports: StreamReportSummary[] }>('/stream-reports')).reports).toEqual(
    [],
  );

  // The page follows the frames from Ana to Bia.
  await ana.page.goto(`/transmissoes/${report.id}`);
  await expect(ana.page.getByRole('heading', { name: 'Ana', exact: true })).toBeVisible();
  await expect(ana.page.getByText('BIA ASSISTINDO')).toBeVisible();
  await expect(ana.page.getByRole('img', { name: /CHEGANDO AO SERVIDOR/ })).toBeVisible();
  await expect(ana.page.getByRole('img', { name: /EXIBIDO PARA BIA/ })).toBeVisible();
  if (process.env.E2E_SCREENSHOT_DIR) {
    await ana.page.screenshot({
      path: `${process.env.E2E_SCREENSHOT_DIR}/stream-report.png`,
      fullPage: true,
    });
  }
});
