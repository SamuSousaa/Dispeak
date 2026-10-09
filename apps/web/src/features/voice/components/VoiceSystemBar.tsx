import { Metric } from '../../../components/LabLayout';
import { cx } from '../../../lib/cx';
import { useVoiceStore, type VoiceStatus } from '../voice-store';

const statusLabel: Record<VoiceStatus, string> = {
  idle: 'DESCONECTADO',
  connecting: 'CONECTANDO',
  connected: 'CONECTADO',
  reconnecting: 'RECONECTANDO',
  error: 'ERRO',
};

const dash = (value: number | string | null, unit = '') =>
  value === null ? '—' : `${value}${unit}`;

/** System layer: live numbers of the media connection, never decorative. */
export function VoiceSystemBar() {
  const status = useVoiceStore((state) => state.status);
  const stats = useVoiceStore((state) => state.stats);
  const participants = useVoiceStore((state) => Object.keys(state.peers).length + 1);

  return (
    <>
      <Metric
        label="MÍDIA"
        value={
          <span
            data-testid="voice-status"
            className={cx(
              status === 'connected' && 'text-accent',
              (status === 'error' || status === 'reconnecting') && 'text-danger',
            )}
          >
            {statusLabel[status]}
          </span>
        }
      />
      <Metric label="RTT" value={dash(stats.rttMs, ' MS')} />
      <Metric
        className="hidden sm:inline"
        label="↑"
        value={<span data-testid="voice-send">{dash(stats.sendKbps, ' KBPS')}</span>}
      />
      <Metric
        label="↓"
        value={<span data-testid="voice-receive">{dash(stats.receiveKbps, ' KBPS')}</span>}
      />
      <Metric className="hidden sm:inline" label="PERDA" value={dash(stats.lossPercent, '%')} />
      <Metric
        className="hidden sm:inline"
        label="CODEC"
        value={dash(stats.audioCodec?.toUpperCase() ?? null)}
      />
      <Metric label="PARTICIPANTES" value={<span data-testid="voice-count">{participants}</span>} />
    </>
  );
}
