import { Metric } from '../../components/LabLayout';
import { cx } from '../../lib/cx';
import { useGatewayStore, type GatewayStatus } from '../gateway/gateway-store';
import { VoiceSystemBar } from '../voice/components/VoiceSystemBar';
import { useVoiceStore } from '../voice/voice-store';

const gatewayLabel: Record<GatewayStatus, string> = {
  idle: 'DESCONECTADO',
  connecting: 'CONECTANDO',
  ready: 'CONECTADO',
  reconnecting: 'RECONECTANDO',
};

/** System layer at the bottom of the app: real connection data, nothing decorative. */
export function SystemBar() {
  const gateway = useGatewayStore((state) => state.status);
  const voice = useVoiceStore((state) => state.status);

  return (
    <footer className="label flex min-h-8 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-t border-line bg-surface px-3 py-1.5 text-muted max-md:flex-nowrap max-md:overflow-x-auto max-md:whitespace-nowrap">
      <Metric
        label="GATEWAY"
        value={
          <span
            data-testid="gateway-status"
            className={cx(gateway === 'ready' ? 'text-accent' : 'text-danger')}
          >
            {gatewayLabel[gateway]}
          </span>
        }
      />
      {voice !== 'idle' && voice !== 'error' && <VoiceSystemBar />}
    </footer>
  );
}
