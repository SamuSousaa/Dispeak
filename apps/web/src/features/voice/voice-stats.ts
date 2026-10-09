import type { VoiceConnectionStats } from './voice-store';

export interface StatsSample {
  at: number;
  bytesSent: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
}

type StatsEntry = Record<string, unknown> & { type: string; id: string };

const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

export function entries(report: RTCStatsReport): StatsEntry[] {
  const list: StatsEntry[] = [];
  report.forEach((entry) => list.push(entry as StatsEntry));
  return list;
}

/** Short codec name ("opus", "VP8") for an RTP stream entry. */
export function codecOf(report: RTCStatsReport, entry: StatsEntry | undefined): string | null {
  const codecId = entry?.codecId;
  if (typeof codecId !== 'string') return null;
  const codec = report.get(codecId) as { mimeType?: string } | undefined;
  return codec?.mimeType?.split('/')[1] ?? null;
}

export function kbps(bytes: number, previousBytes: number, seconds: number): number {
  if (seconds <= 0) return 0;
  return Math.max(0, Math.round(((bytes - previousBytes) * 8) / seconds / 1000));
}

/**
 * Reduces the send and receive transport reports to the handful of numbers shown in the
 * system bar. Rates are computed against the previous sample.
 */
export function collectConnectionStats(
  sent: RTCStatsReport,
  received: RTCStatsReport,
  previous: StatsSample | null,
  now = performance.now(),
): { stats: VoiceConnectionStats; sample: StatsSample } {
  const sendEntries = entries(sent);
  const receiveEntries = entries(received);

  let rttMs: number | null = null;
  for (const entry of [...sendEntries, ...receiveEntries]) {
    if (
      entry.type === 'candidate-pair' &&
      entry.nominated === true &&
      typeof entry.currentRoundTripTime === 'number'
    ) {
      const value = Math.round(entry.currentRoundTripTime * 1000);
      rttMs = rttMs === null ? value : Math.min(rttMs, value);
    }
  }

  const sum = (list: StatsEntry[], type: string, field: string) =>
    list
      .filter((entry) => entry.type === type)
      .reduce((total, entry) => total + number(entry[field]), 0);

  const sample: StatsSample = {
    at: now,
    bytesSent: sum(sendEntries, 'outbound-rtp', 'bytesSent'),
    bytesReceived: sum(receiveEntries, 'inbound-rtp', 'bytesReceived'),
    packetsReceived: sum(receiveEntries, 'inbound-rtp', 'packetsReceived'),
    packetsLost: sum(receiveEntries, 'inbound-rtp', 'packetsLost'),
  };

  const audioOut = sendEntries.find(
    (entry) => entry.type === 'outbound-rtp' && entry.kind === 'audio',
  );
  const audioIn = receiveEntries.find(
    (entry) => entry.type === 'inbound-rtp' && entry.kind === 'audio',
  );
  const audioCodec = codecOf(sent, audioOut) ?? codecOf(received, audioIn);

  if (!previous) {
    return {
      sample,
      stats: { rttMs, sendKbps: null, receiveKbps: null, lossPercent: null, audioCodec },
    };
  }

  const seconds = (now - previous.at) / 1000;
  const lost = Math.max(0, sample.packetsLost - previous.packetsLost);
  const arrived = Math.max(0, sample.packetsReceived - previous.packetsReceived);
  const expected = lost + arrived;

  return {
    sample,
    stats: {
      rttMs,
      sendKbps: kbps(sample.bytesSent, previous.bytesSent, seconds),
      receiveKbps: kbps(sample.bytesReceived, previous.bytesReceived, seconds),
      lossPercent: expected > 0 ? Math.round((lost / expected) * 1000) / 10 : 0,
      audioCodec,
    },
  };
}
