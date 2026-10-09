import { nicknameSchema, p2pRoomIdSchema } from '@frequencia/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
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

function JoinForm() {
  const [params, setParams] = useSearchParams();
  const [room, setRoom] = useState(params.get('sala') ?? '');
  const [nickname, setNickname] = useState(() => localStorage.getItem('lab.nickname') ?? '');
  const status = useP2pStore((state) => state.status);
  const error = useP2pStore((state) => state.error);
  const [formError, setFormError] = useState<string | null>(null);
  const busy = status === 'acquiring' || status === 'connecting';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsedRoom = p2pRoomIdSchema.safeParse(room);
    const parsedNickname = nicknameSchema.safeParse(nickname);
    if (!parsedNickname.success) {
      setFormError('Apelido: 2 a 24 caracteres (letras, números, espaço, _ . -).');
      return;
    }
    if (!parsedRoom.success) {
      setFormError('Sala: até 32 caracteres, apenas letras, números, _ e -.');
      return;
    }
    setFormError(null);
    localStorage.setItem('lab.nickname', parsedNickname.data);
    setParams({ sala: parsedRoom.data }, { replace: true });
    void joinP2pRoom(parsedRoom.data, parsedNickname.data);
  };

  return (
    <div className="grid-bg flex h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm border border-line bg-surface" noValidate>
        <div className="border-b border-line px-4 py-4">
          <p className="label text-muted">CHAMADA 1:1</p>
          <p className="mt-1 text-sm text-muted">
            Conexão direta entre dois navegadores. Abra a mesma sala em outra aba ou dispositivo.
          </p>
        </div>
        <div className="flex flex-col gap-4 p-4">
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted">APELIDO</span>
            <input
              className="field"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              autoComplete="nickname"
              maxLength={24}
              required
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted">SALA</span>
            <input
              className="field"
              value={room}
              onChange={(event) => setRoom(event.target.value)}
              placeholder="ex.: teste-01"
              maxLength={32}
              autoCapitalize="none"
              required
            />
          </label>
          {(formError ?? error) && (
            <p role="alert" className="label text-danger">
              {formError ?? error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'CONECTANDO' : 'ENTRAR'}
          </Button>
        </div>
      </form>
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
        <JoinForm />
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
