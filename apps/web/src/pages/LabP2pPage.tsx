import { useEffect } from 'react';
import { Button } from '../components/Button';
import { LabJoinForm } from '../components/LabJoinForm';
import { LabLayout, Metric } from '../components/LabLayout';
import { MediaVideo } from '../components/MediaVideo';
import {
  joinP2pRoom,
  leaveP2pRoom,
  toggleP2pCamera,
  toggleP2pMic,
  useP2pStore,
  type P2pStatus,
} from '../features/p2p/p2p-call';
import { cx } from '../lib/cx';

const statusLabel: Record<P2pStatus, string> = {
  idle: 'DESCONECTADO',
  acquiring: 'AGUARDANDO PERMISSÃO',
  connecting: 'CONECTANDO',
  waiting: 'AGUARDANDO PAR',
  'in-call': 'EM CHAMADA',
  error: 'ERRO',
};

function Tile({
  stream,
  label,
  placeholder,
  mirrored = false,
  muted = false,
  testId,
}: {
  stream: MediaStream | null;
  label: string;
  placeholder: string;
  mirrored?: boolean;
  muted?: boolean;
  testId: string;
}) {
  const hasVideo = Boolean(stream?.getVideoTracks().some((track) => track.enabled));
  return (
    <div className="relative min-h-0 border border-line bg-surface">
      <MediaVideo
        stream={stream}
        muted={muted}
        data-testid={testId}
        className={cx(
          'h-full w-full bg-bg object-contain',
          mirrored && '-scale-x-100',
          !hasVideo && 'invisible',
        )}
      />
      {!hasVideo && (
        <div className="label absolute inset-0 flex items-center justify-center text-muted">
          {placeholder}
        </div>
      )}
      <span className="label absolute bottom-0 left-0 border-t border-r border-line bg-bg px-2 py-1 text-fg">
        {label}
      </span>
    </div>
  );
}

export function LabP2pPage() {
  const status = useP2pStore((state) => state.status);
  const self = useP2pStore((state) => state.self);
  const remote = useP2pStore((state) => state.remote);
  const localStream = useP2pStore((state) => state.localStream);
  const remoteStream = useP2pStore((state) => state.remoteStream);
  const micEnabled = useP2pStore((state) => state.micEnabled);
  const cameraEnabled = useP2pStore((state) => state.cameraEnabled);
  const hasCamera = useP2pStore((state) => state.hasCamera);
  const iceState = useP2pStore((state) => state.iceState);
  const stats = useP2pStore((state) => state.stats);
  const error = useP2pStore((state) => state.error);

  useEffect(() => leaveP2pRoom, []);

  const inRoom = status === 'waiting' || status === 'in-call';
  const dash = (value: number | string | null, unit = '') =>
    value === null ? '—' : `${value}${unit}`;

  return (
    <LabLayout
      code="LAB.01"
      title="P2P 1:1"
      status={
        <span data-testid="p2p-status" className={cx(status === 'in-call' && 'text-accent')}>
          {statusLabel[status]}
        </span>
      }
      footer={
        inRoom && (
          <>
            <Metric label="ICE" value={<span data-testid="p2p-ice">{dash(iceState)}</span>} />
            <Metric label="RTT" value={dash(stats.rttMs, ' MS')} />
            <Metric label="↑" value={dash(stats.sendKbps, ' KBPS')} />
            <Metric label="↓" value={dash(stats.receiveKbps, ' KBPS')} />
            <Metric
              label="CODEC"
              value={[stats.videoCodec, stats.audioCodec].filter(Boolean).join(' + ') || '—'}
            />
          </>
        )
      }
    >
      {!inRoom ? (
        <LabJoinForm
          title="CHAMADA 1:1"
          description="Conexão direta entre dois navegadores. Abra a mesma sala em outra aba ou dispositivo."
          roomLabel="SALA"
          roomParam="sala"
          busy={status === 'acquiring' || status === 'connecting'}
          error={error}
          onJoin={(room, nickname) => void joinP2pRoom(room, nickname)}
        />
      ) : (
        <div className="flex h-full flex-col">
          <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-2 gap-px bg-bg p-3 md:grid-cols-2 md:grid-rows-1 md:gap-3">
            <Tile
              stream={remoteStream}
              label={remote?.nickname ?? '—'}
              placeholder={remote ? 'SEM VÍDEO' : 'AGUARDANDO OUTRA PESSOA ENTRAR NA SALA'}
              testId="p2p-remote-video"
            />
            <Tile
              stream={localStream}
              label={`${self?.nickname ?? ''} (VOCÊ)`}
              placeholder={hasCamera ? 'CÂMERA DESLIGADA' : 'SEM CÂMERA'}
              mirrored
              muted
              testId="p2p-local-video"
            />
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-line bg-surface p-3">
            <Button
              variant={micEnabled ? 'default' : 'danger'}
              aria-pressed={!micEnabled}
              onClick={toggleP2pMic}
            >
              {micEnabled ? 'MUTAR' : 'MUTADO'}
            </Button>
            <Button
              variant={cameraEnabled ? 'default' : 'danger'}
              aria-pressed={!cameraEnabled}
              onClick={toggleP2pCamera}
              disabled={!hasCamera}
            >
              {cameraEnabled ? 'DESLIGAR CÂMERA' : 'CÂMERA DESLIGADA'}
            </Button>
            <Button variant="danger" onClick={leaveP2pRoom}>
              SAIR
            </Button>
          </div>
        </div>
      )}
    </LabLayout>
  );
}
