import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * A screen published outside the browser: ffmpeg sends SRTP to the plain transport the media
 * service opens for a native capture, and a browser has to decode what comes out. Needs an
 * ffmpeg with libx264 and libsvtav1 (`E2E_FFMPEG=<path to ffmpeg>`); skipped without one.
 * `E2E_INGEST_HW=amf` or `nvenc` runs it through the graphics card's encoder instead.
 */
const ffmpeg = process.env.E2E_FFMPEG;
const hardware = process.env.E2E_INGEST_HW;

const ENCODERS: Record<'h264' | 'av1', string[]> = {
  h264: hardware
    ? ['-c:v', `h264_${hardware}`, '-profile:v', 'high', '-bf', '0']
    : ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high'],
  av1: hardware
    ? ['-c:v', `av1_${hardware}`]
    : ['-c:v', 'libsvtav1', '-preset', '12', '-svtav1-params', 'pred-struct=1:rc=2'],
};

interface Ingest {
  producerId: string;
  address: string;
  rtpPort: number;
  rtcpPort: number;
  ssrc: number;
  payloadType: number;
  srtp: { cryptoSuite: string; keyBase64: string };
}

/** The voice signaling of a participant that is not a browser: requests and their answers. */
async function connectSignaling(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('signaling refused')), { once: true });
  });
  const pending = new Map<number, (frame: { ok: boolean; data?: unknown }) => void>();
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as { t: string; id: number; ok: boolean };
    if (frame.t === 'res') pending.get(frame.id)?.(frame);
  });
  let nextId = 1;
  return {
    request: <T>(method: string, data: unknown) =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (frame) => {
          pending.delete(id);
          if (frame.ok) resolve(frame.data as T);
          else reject(new Error(`${method} failed: ${JSON.stringify(frame)}`));
        });
        socket.send(JSON.stringify({ t: 'req', id, method, data }));
      }),
    close: () => socket.close(),
  };
}

async function join(browser: Browser, channel: string, nickname: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`/lab/voice?canal=${channel}`);
  await page.getByLabel('APELIDO').fill(nickname);
  await page.getByRole('button', { name: 'ENTRAR' }).click();
  await expect(page.getByTestId('voice-status')).toHaveText('CONECTADO');
  return page;
}

for (const codec of ['h264', 'av1'] as const) {
  test(`a browser watches a screen ingested as ${codec}`, async ({ browser, request, baseURL }) => {
    test.skip(!ffmpeg, 'set E2E_FFMPEG to the path of an ffmpeg binary');
    test.skip(
      codec === 'h264' && !process.env.E2E_CHANNEL,
      'the bundled Chromium has no H.264 decoder; run with E2E_CHANNEL=chrome',
    );
    test.setTimeout(90_000);
    const channel = `e2e-ingest-${codec}-${Date.now()}`;
    const viewer = await join(browser, channel, 'Carla');

    const response = await request.post('/api/lab/voice-token', {
      data: { nickname: 'Nativo', channel, clientId: randomUUID() },
    });
    const { token } = (await response.json()) as { token: string };
    const origin = new URL(baseURL ?? 'http://localhost:5173');
    const signaling = await connectSignaling(
      `${origin.protocol === 'https:' ? 'wss' : 'ws'}://${origin.host}/media/voice?token=${token}`,
    );
    let sender: ChildProcess | undefined;
    try {
      const { rtpCapabilities } = await signaling.request<{ rtpCapabilities: unknown }>(
        'getRouterCapabilities',
        {},
      );
      await signaling.request('join', { rtpCapabilities, muted: true, deafened: false });
      const ingest = await signaling.request<Ingest>('createIngest', { codec });

      const output =
        `srtp://${ingest.address}:${ingest.rtpPort}` + `?rtcpport=${ingest.rtcpPort}&pkt_size=1200`;
      sender = spawn(
        ffmpeg as string,
        [
          ...['-hide_banner', '-loglevel', 'error', '-re'],
          ...['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'],
          ...ENCODERS[codec],
          ...['-pix_fmt', 'yuv420p', '-b:v', '2M', '-g', '30', '-strict', 'experimental'],
          ...(codec === 'h264' ? ['-bsf:v', 'dump_extra=freq=keyframe'] : []),
          ...['-f', 'rtp', '-ssrc', String(ingest.ssrc)],
          ...['-payload_type', String(ingest.payloadType)],
          ...['-srtp_out_suite', ingest.srtp.cryptoSuite],
          ...['-srtp_out_params', ingest.srtp.keyBase64, output],
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] },
      );

      await viewer.getByRole('button', { name: 'Assistir Nativo' }).click();
      const video = viewer.locator('[data-stream="Nativo"]').getByTestId('stream-video');
      await expect
        .poll(() => video.evaluate((element) => (element as HTMLVideoElement).videoWidth), {
          timeout: 30_000,
        })
        .toBe(1280);
      // Not just a first picture: frames keep being decoded.
      const decoded = () =>
        video.evaluate(
          (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
        );
      const before = await decoded();
      await expect.poll(decoded, { timeout: 15_000 }).toBeGreaterThan(before + 30);
    } finally {
      sender?.kill();
      signaling.close();
    }
  });
}
