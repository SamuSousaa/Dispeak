import { useState } from 'react';
import { contextMenu } from '../../../components/ContextMenu';
import { cx } from '../../../lib/cx';
import { useSettingsStore } from '../../settings/settings-store';
import { setCameraViewport, stopScreenShare, unwatchStream, watchStream } from '../voice-actions';
import { isLive, SELF_STREAM, useVoiceStore } from '../voice-store';
import { ParticipantTile } from './ParticipantTile';
import { StreamTile } from './StreamTile';
import { volumeLabel, volumeMenuEntries } from './VolumeControl';

interface StageStream {
  id: string;
  name: string;
  stream: MediaStream | null;
}

const gridColumns = (count: number) =>
  count <= 1
    ? 'grid-cols-1'
    : count <= 4
      ? 'grid-cols-1 md:grid-cols-2'
      : 'grid-cols-2 lg:grid-cols-3';

/**
 * Main area of a voice channel. With no stream on screen it is a grid of participants; once
 * the user watches a stream (or shares their own) the streams take over and the participants
 * move to a strip below.
 */
export function VoiceStage({ selfName }: { selfName: string }) {
  const selfId = useVoiceStore((state) => state.selfId);
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const peers = useVoiceStore((state) => state.peers);
  const speaking = useVoiceStore((state) => state.speaking);
  const screen = useVoiceStore((state) => state.screen);
  const camera = useVoiceStore((state) => state.camera);
  const cameras = useVoiceStore((state) => state.cameras);
  const watching = useVoiceStore((state) => state.watching);
  const userVolumes = useSettingsStore((state) => state.userVolumes);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const others = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const streams: StageStream[] = [
    ...(screen.status === 'live'
      ? [{ id: SELF_STREAM, name: selfName, stream: screen.stream }]
      : []),
    ...others
      .filter((peer) => watching[peer.id])
      .map((peer) => ({ id: peer.id, name: peer.name, stream: watching[peer.id]?.stream ?? null })),
  ];
  const focused = streams.find((stream) => stream.id === focusedId);
  const hasStreams = streams.length > 0;

  const streamTile = (stream: StageStream, compact = false) => (
    <StreamTile
      key={stream.id}
      id={stream.id}
      name={stream.name}
      stream={stream.stream}
      focused={stream.id === focused?.id}
      compact={compact}
      onToggleFocus={() => setFocusedId(stream.id === focused?.id ? null : stream.id)}
      onClose={() => (stream.id === SELF_STREAM ? stopScreenShare() : unwatchStream(stream.id))}
    />
  );

  const participants = (
    <>
      <li className={cx(hasStreams && 'h-full')}>
        <ParticipantTile
          name={selfName}
          isSelf
          speaking={selfId !== null && speaking.includes(selfId)}
          muted={muted}
          deafened={deafened}
          live={screen.status === 'live'}
          video={camera.stream}
          compact={hasStreams}
        />
      </li>
      {others.map((peer) => (
        <li key={peer.id} className={cx(hasStreams && 'h-full')}>
          <ParticipantTile
            name={peer.name}
            speaking={speaking.includes(peer.id)}
            muted={peer.muted}
            deafened={peer.deafened}
            live={isLive(peer)}
            watching={Boolean(watching[peer.id])}
            video={cameras[peer.id] ?? null}
            onVideoViewport={(cssHeight) => setCameraViewport(peer.id, cssHeight)}
            onWatch={() => watchStream(peer.id)}
            onUnwatch={() => unwatchStream(peer.id)}
            compact={hasStreams}
            volumeNote={volumeLabel(userVolumes[peer.userId] ?? 1)}
            menu={contextMenu(peer.name, () => [
              ...volumeMenuEntries(peer.userId, peer.name),
              { type: 'separator' },
              isLive(peer) &&
                (watching[peer.id]
                  ? { label: 'Parar de assistir', onSelect: () => unwatchStream(peer.id) }
                  : { label: 'Assistir transmissão', onSelect: () => watchStream(peer.id) }),
            ])}
          />
        </li>
      ))}
    </>
  );

  if (!hasStreams) {
    return (
      <div className="grid-bg h-full overflow-y-auto p-3">
        <ul
          aria-label="Participantes"
          className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]"
        >
          {participants}
        </ul>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 p-3">
        {focused ? (
          <div className="flex h-full flex-col gap-3 md:flex-row">
            <div className="min-h-0 min-w-0 flex-1">{streamTile(focused)}</div>
            {streams.length > 1 && (
              <div
                aria-label="Outras transmissões"
                className="flex h-28 shrink-0 gap-3 overflow-auto md:h-auto md:w-56 md:flex-col"
              >
                {streams
                  .filter((stream) => stream.id !== focused.id)
                  .map((stream) => (
                    <div
                      key={stream.id}
                      className="aspect-video h-full shrink-0 md:h-auto md:w-full"
                    >
                      {streamTile(stream, true)}
                    </div>
                  ))}
              </div>
            )}
          </div>
        ) : (
          <div className={cx('grid h-full auto-rows-fr gap-3', gridColumns(streams.length))}>
            {streams.map((stream) => streamTile(stream))}
          </div>
        )}
      </div>
      <ul
        aria-label="Participantes"
        className="flex h-32 shrink-0 gap-3 overflow-x-auto border-t border-line bg-surface p-3"
      >
        {participants}
      </ul>
    </div>
  );
}
