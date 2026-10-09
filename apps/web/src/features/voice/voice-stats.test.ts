import { describe, expect, it } from 'vitest';
import { collectConnectionStats } from './voice-stats';

function report(entries: Array<Record<string, unknown> & { id: string; type: string }>) {
  return new Map(entries.map((entry) => [entry.id, entry])) as unknown as RTCStatsReport;
}

const send = (bytesSent: number) =>
  report([
    { id: 'codec-opus', type: 'codec', mimeType: 'audio/opus' },
    { id: 'out-audio', type: 'outbound-rtp', kind: 'audio', bytesSent, codecId: 'codec-opus' },
    { id: 'pair', type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.042 },
    { id: 'pair-unused', type: 'candidate-pair', nominated: false, currentRoundTripTime: 0.5 },
  ]);

const receive = (bytesReceived: number, packetsReceived: number, packetsLost: number) =>
  report([
    { id: 'in-1', type: 'inbound-rtp', kind: 'audio', bytesReceived, packetsReceived, packetsLost },
    { id: 'in-2', type: 'inbound-rtp', kind: 'audio', bytesReceived: 0, packetsReceived: 0 },
  ]);

describe('collectConnectionStats', () => {
  it('reports RTT and codec on the first sample, but no rates yet', () => {
    const { stats } = collectConnectionStats(send(1000), receive(2000, 10, 0), null, 0);
    expect(stats).toEqual({
      rttMs: 42,
      sendKbps: null,
      receiveKbps: null,
      lossPercent: null,
      audioCodec: 'opus',
    });
  });

  it('derives bitrates and packet loss from the previous sample', () => {
    const first = collectConnectionStats(send(0), receive(0, 0, 0), null, 0);
    const { stats } = collectConnectionStats(
      send(8000),
      receive(16_000, 95, 5),
      first.sample,
      2000,
    );
    expect(stats.sendKbps).toBe(32);
    expect(stats.receiveKbps).toBe(64);
    expect(stats.lossPercent).toBe(5);
  });

  it('never reports negative rates when counters reset', () => {
    const first = collectConnectionStats(send(9000), receive(9000, 50, 4), null, 0);
    const { stats } = collectConnectionStats(send(100), receive(100, 5, 0), first.sample, 1000);
    expect(stats.sendKbps).toBe(0);
    expect(stats.receiveKbps).toBe(0);
    expect(stats.lossPercent).toBe(0);
  });
});
