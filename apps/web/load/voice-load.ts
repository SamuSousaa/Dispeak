// Voice + screen share under load: N headless Chromium participants in one voice channel,
// with synthetic microphones; one of them streams its screen and everyone else watches.
//
//   pnpm --filter @frequencia/web load:voice
//   PARTICIPANTS=16 DURATION_S=60 pnpm --filter @frequencia/web load:voice
//
// It goes through the real product flow (accounts, invite, voice token, SFU) and samples the
// Prometheus endpoints of both services plus playback statistics inside every viewer.
// Environment:
//   BASE_URL            web origin                      (default http://localhost:5173)
//   API_METRICS_URL     API metrics                     (default http://localhost:4000/metrics)
//   MEDIA_METRICS_URL   media metrics                   (default http://localhost:4100/media/metrics)
//   MEDIA_SECRET        bearer for media metrics outside development
//   METRICS_TOKEN       bearer for API metrics, when configured
//   PARTICIPANTS        people in the channel           (default 8)
//   DURATION_S          measured window in seconds      (default 60)
//   PRESET              stream quality                  (default 1080P30)
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
const API_METRICS_URL = process.env.API_METRICS_URL ?? 'http://localhost:4000/metrics';
const MEDIA_METRICS_URL = process.env.MEDIA_METRICS_URL ?? 'http://localhost:4100/media/metrics';
const PARTICIPANTS = Number(process.env.PARTICIPANTS ?? 8);
const DURATION_S = Number(process.env.DURATION_S ?? 60);
const PRESET = process.env.PRESET ?? '1080P30';
const SAMPLE_EVERY_S = 5;
const WARM_UP_S = 10;

interface Participant {
  name: string;
  context: BrowserContext;
  page: Page;
  token: string;
}

interface ServerSample {
  at: number;
  workerCpuSeconds: number;
  mediaProcessCpuSeconds: number;
  apiProcessCpuSeconds: number;
  producers: number;
  consumers: number;
  participants: number;
}

interface ViewerSample {
  totalFrames: number;
  droppedFrames: number;
  width: number;
  height: number;
  receiveKbps: number;
  rttMs: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round = (value: number, digits = 1) => Number(value.toFixed(digits));

/** Sum of every sample of a metric, optionally restricted to lines containing `filter`. */
function metric(text: string, name: string, filter = ''): number {
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && line.includes(filter))
    .reduce((sum, line) => sum + Number(line.split(' ').at(-1)), 0);
}

async function scrape(url: string, token: string | undefined): Promise<string> {
  const response = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
}

async function sampleServer(): Promise<ServerSample> {
  const [media, api] = await Promise.all([
    scrape(MEDIA_METRICS_URL, process.env.MEDIA_SECRET),
    scrape(API_METRICS_URL, process.env.METRICS_TOKEN),
  ]);
  return {
    at: Date.now(),
    workerCpuSeconds: metric(media, 'frequencia_media_worker_cpu_seconds_total'),
    mediaProcessCpuSeconds: metric(media, 'process_cpu_seconds_total'),
    apiProcessCpuSeconds: metric(api, 'process_cpu_seconds_total'),
    producers: metric(media, 'frequencia_media_producers'),
    consumers: metric(media, 'frequencia_media_consumers'),
    participants: metric(media, 'frequencia_voice_participants'),
  };
}

async function sampleViewer(page: Page): Promise<ViewerSample> {
  return page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="stream-video"]');
    const quality = video?.getVideoPlaybackQuality();
    const number = (testId: string) =>
      Number.parseFloat(document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '') ||
      0;
    const rtt = [...document.querySelectorAll('footer span')]
      .map((element) => element.textContent ?? '')
      .find((text) => text.startsWith('RTT'));
    return {
      totalFrames: quality?.totalVideoFrames ?? 0,
      droppedFrames: quality?.droppedVideoFrames ?? 0,
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
      receiveKbps: number('voice-receive'),
      rttMs: Number.parseFloat(rtt?.replace('RTT', '') ?? '') || 0,
    };
  });
}

async function main(): Promise<void> {
  console.log(`[load] ${PARTICIPANTS} participants, ${PRESET}, ${DURATION_S}s at ${BASE_URL}`);
  const browser = await chromium.launch({
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen',
      '--autoplay-policy=no-user-gesture-required',
      // Keep every page rendering although none of them is in the foreground.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const run = Date.now().toString(36);
  const participants: Participant[] = [];
  let guildId = '';
  let voiceChannelId = '';
  let inviteCode = '';

  try {
    // --- accounts, server, invite -----------------------------------------------------------
    for (let index = 0; index < PARTICIPANTS; index++) {
      const name = `P${String(index + 1).padStart(2, '0')}`;
      const context = await browser.newContext({
        baseURL: BASE_URL,
        viewport: { width: 1280, height: 720 },
        permissions: ['microphone', 'camera'],
      });
      const call = async (method: 'post', url: string, data?: unknown, token?: string) => {
        const response = await context.request[method](`/api${url}`, {
          data,
          headers: token ? { authorization: `Bearer ${token}` } : {},
        });
        if (!response.ok()) throw new Error(`${url} -> ${response.status()}`);
        return response.json() as Promise<unknown>;
      };

      const session = (await call('post', '/auth/register', {
        username: `load${run}${index}`,
        displayName: name,
        password: 'correct horse battery',
      })) as { accessToken: string };
      const token = session.accessToken;
      if (index === 0) {
        const guild = (await call('post', '/guilds', { name: `Carga ${run}` }, token)) as {
          id: string;
          channels: Array<{ id: string; type: string }>;
        };
        guildId = guild.id;
        voiceChannelId = guild.channels.find((channel) => channel.type === 'voice')?.id ?? '';
        inviteCode = (
          (await call('post', `/guilds/${guildId}/invites`, {}, token)) as { code: string }
        ).code;
      } else {
        await call('post', `/invites/${inviteCode}/accept`, undefined, token);
      }
      participants.push({ name, context, page: await context.newPage(), token });
    }

    // --- everyone joins the voice channel ---------------------------------------------------
    for (const { page, name } of participants) {
      await page.goto(`/app/${guildId}/${voiceChannelId}`);
      await page.getByRole('button', { name: 'ENTRAR NO CANAL' }).click();
      await page
        .locator('[data-testid="voice-status"]', { hasText: 'CONECTADO' })
        .waitFor({ timeout: 30_000 });
      console.log(`[load] ${name} connected`);
    }

    // --- one streams, the rest watch --------------------------------------------------------
    const [streamer, ...viewers] = participants;
    if (!streamer) throw new Error('at least one participant is required');
    streamer.page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log(`[load] ${streamer.name} console: ${message.text()}`);
      }
    });
    await streamer.page.getByRole('button', { name: 'TRANSMITIR', exact: true }).click();
    await streamer.page.getByRole('menuitem', { name: new RegExp(PRESET) }).click();
    for (const viewer of viewers) {
      await viewer.page.getByRole('button', { name: `Assistir ${streamer.name}` }).click();
    }
    console.log(`[load] ${streamer.name} is live, ${viewers.length} watching; warming up`);
    await sleep(WARM_UP_S * 1000);

    // --- measure ----------------------------------------------------------------------------
    const server: ServerSample[] = [await sampleServer()];
    const first = await Promise.all(viewers.map((viewer) => sampleViewer(viewer.page)));
    const viewerSeries: ViewerSample[][] = [];
    for (let elapsed = 0; elapsed < DURATION_S; elapsed += SAMPLE_EVERY_S) {
      await sleep(SAMPLE_EVERY_S * 1000);
      server.push(await sampleServer());
      viewerSeries.push(await Promise.all(viewers.map((viewer) => sampleViewer(viewer.page))));
    }
    const last = viewerSeries.at(-1) ?? first;
    const start = server[0] as ServerSample;
    const end = server.at(-1) as ServerSample;
    const seconds = (end.at - start.at) / 1000;

    const fps = last.map(
      (sample, index) => (sample.totalFrames - (first[index]?.totalFrames ?? 0)) / seconds,
    );
    const frames = last.reduce(
      (sum, sample, index) => sum + sample.totalFrames - (first[index]?.totalFrames ?? 0),
      0,
    );
    const dropped = last.reduce(
      (sum, sample, index) => sum + sample.droppedFrames - (first[index]?.droppedFrames ?? 0),
      0,
    );
    const allSamples = viewerSeries.flat();
    const resolutions: Record<string, number> = {};
    for (const sample of last) {
      const key = `${sample.width}x${sample.height}`;
      resolutions[key] = (resolutions[key] ?? 0) + 1;
    }

    const result = {
      participants: PARTICIPANTS,
      viewers: viewers.length,
      preset: PRESET,
      measuredSeconds: round(seconds, 0),
      server: {
        producers: end.producers,
        consumers: end.consumers,
        // CPU seconds per wall-clock second: 1.0 means one core fully busy.
        workerCpuCores: round((end.workerCpuSeconds - start.workerCpuSeconds) / seconds, 3),
        mediaProcessCpuCores: round(
          (end.mediaProcessCpuSeconds - start.mediaProcessCpuSeconds) / seconds,
          3,
        ),
        apiProcessCpuCores: round(
          (end.apiProcessCpuSeconds - start.apiProcessCpuSeconds) / seconds,
          3,
        ),
      },
      viewersPlayback: {
        fpsAverage: round(average(fps)),
        fpsWorst: round(Math.min(...fps, Number.POSITIVE_INFINITY)),
        droppedFramesPercent: frames > 0 ? round((dropped / frames) * 100, 2) : 0,
        resolutions,
        receiveKbpsAverage: round(average(allSamples.map((sample) => sample.receiveKbps)), 0),
        rttMsAverage: round(average(allSamples.map((sample) => sample.rttMs))),
      },
    };

    console.log(JSON.stringify(result, null, 2));
    const directory = path.resolve(import.meta.dirname, '../../../load/results');
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `voice-${PARTICIPANTS}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  } catch (error) {
    // Leave evidence of what the pages looked like when the run broke.
    const directory = path.resolve(import.meta.dirname, '../../../load/results');
    await mkdir(directory, { recursive: true });
    for (const participant of [participants[0], participants.at(-1)]) {
      await participant?.page
        .screenshot({ path: path.join(directory, `failure-${participant.name}.png`) })
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await browser.close();
  }
}

await main();
