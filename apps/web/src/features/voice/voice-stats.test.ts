import { describe, expect, it } from 'vitest';
import { collectConnectionStats, collectInboundStreamStats } from './voice-stats';

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

describe('collectInboundStreamStats', () => {
  const inbound = (fields: Record<string, unknown>) =>
    report([
      {
        id: 'in-video',
        type: 'inbound-rtp',
        kind: 'video',
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 59.6,
        decoderImplementation: 'D3D11VideoDecoder',
        ...fields,
      },
    ]);

  it('reports what the viewer saw since the previous sample', () => {
    const first = collectInboundStreamStats(
      inbound({
        bytesReceived: 0,
        packetsReceived: 0,
        framesDecoded: 100,
        totalDecodeTime: 0.3,
        framesDropped: 1,
        freezeCount: 2,
        totalFreezesDuration: 0.5,
        jitterBufferDelay: 4,
        jitterBufferEmittedCount: 100,
      }),
      null,
      0,
    );
    expect(first.viewer).toMatchObject({ freezes: 0, freezeMs: 0, decodeMs: null });

    const { viewer } = collectInboundStreamStats(
      inbound({
        bytesReceived: 2_000_000,
        packetsReceived: 1500,
        framesDecoded: 220,
        totalDecodeTime: 0.6,
        framesDropped: 4,
        freezeCount: 3,
        totalFreezesDuration: 0.75,
        jitterBufferDelay: 8.8,
        jitterBufferEmittedCount: 220,
      }),
      first.sample,
      2000,
    );
    expect(viewer).toEqual({
      fps: 60,
      framesDropped: 3,
      freezes: 1,
      freezeMs: 250,
      decodeMs: 2.5,
      jitterBufferMs: 40,
      lossPercent: 0,
      width: 1920,
      height: 1080,
      kbps: 8000,
      decoder: 'D3D11VideoDecoder',
    });
  });
});
