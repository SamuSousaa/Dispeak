import type { Guild } from '@frequencia/shared';
import { useState } from 'react';
import { cx } from '../../../lib/cx';
import { memberColor, memberName } from '../../guilds/permissions';
import { userMenu } from '../../guilds/user-menu';
import { useSettingsStore } from '../../settings/settings-store';
import { setCameraViewport, stopScreenShare, unwatchStream, watchStream } from '../voice-actions';
import { isLive, SELF_STREAM, useVoiceStore } from '../voice-store';
import { ParticipantTile } from './ParticipantTile';
import { StreamTile } from './StreamTile';
import { useFillGrid } from './use-fill-grid';
import { volumeLabel } from './VolumeControl';

interface StageStream {
  id: string;
  name: string;
  stream: MediaStream | null;
  /** Whether the streamer is sending the sound of what they share. */
  hasAudio?: boolean;
}

const gridColumns = (count: number) =>
  count <= 1
    ? 'grid-cols-1'
    : count <= 4
      ? 'grid-cols-1 md:grid-cols-2'
      : 'grid-cols-2 lg:grid-cols-3';

const GAP = 12;

/**
 * Main area of a voice channel. With no stream on screen the participants share the whole
 * area, each tile as large as fits; once the user watches a stream (or shares their own) the
 * streams take over and the participants move to a strip below.
 */
export function VoiceStage({
  guild,
  userId,
  selfName: givenName,
  onManageMembers,
}: {
  /** The server the channel belongs to; absent in the lab, where there are only nicknames. */
  guild?: Guild;
  userId?: string;
  /** Name of the local user when there is no server to look it up in. */
  selfName?: string;
  onManageMembers?: () => void;
}) {
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
  // Kept in state, not in a ref: the grid is unmounted while a stream is on screen, and when it
  // comes back the tiles must be sized again. With a ref nothing noticed the new element, the
  // size stayed at zero and the tiles piled up on top of each other.
  const [grid, setGrid] = useState<HTMLUListElement | null>(null);

  const memberOf = (id: string | undefined) => guild?.members.find((entry) => entry.user.id === id);
  const colorOf = (id: string | undefined) => (guild && id ? memberColor(guild, id) : undefined);
  const menuOf = (targetId: string | undefined) =>
    guild && userId && targetId
      ? userMenu({ guild, targetId, selfId: userId, onManageMembers })
      : undefined;
  const others = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  const cell = useFillGrid(grid, others.length + 1, 16 / 9, GAP);

  const selfName = guild && userId ? memberName(guild, userId) : (givenName ?? '');
  const streams: StageStream[] = [
    ...(screen.status === 'live'
      ? [{ id: SELF_STREAM, name: selfName, stream: screen.stream }]
      : []),
    ...others
      .filter((peer) => watching[peer.id])
      .map((peer) => ({
        id: peer.id,
        name: peer.name,
        stream: watching[peer.id]?.stream ?? null,
        hasAudio: peer.producers.some((producer) => producer.source === 'screen-audio'),
      })),
  ];
  const focused = streams.find((stream) => stream.id === focusedId);
  const hasStreams = streams.length > 0;

  const streamTile = (stream: StageStream, compact = false) => (
    <StreamTile
      key={stream.id}
      id={stream.id}
      name={stream.name}
      stream={stream.stream}
      hasAudio={stream.hasAudio ?? false}
      focused={stream.id === focused?.id}
      compact={compact}
      onToggleFocus={() => setFocusedId(stream.id === focused?.id ? null : stream.id)}
      onClose={() => (stream.id === SELF_STREAM ? stopScreenShare() : unwatchStream(stream.id))}
    />
  );

  // In the strip the tiles follow its height; in the grid each one gets the computed size.
  // Until the grid has been measured the tiles fall back to a plain 16:9 box.
  const measured = cell.width > 0 && cell.height > 0;
  const slot = hasStreams || !measured ? undefined : { width: cell.width, height: cell.height };
  const slotClass = hasStreams ? 'h-full' : measured ? 'shrink-0' : 'aspect-video w-full max-w-xl';

  const participants = (
    <>
      <li className={slotClass} style={slot}>
        <ParticipantTile
          name={selfName}
          nameColor={colorOf(userId)}
          isSelf
          speaking={selfId !== null && speaking.includes(selfId)}
          muted={muted}
          deafened={deafened}
          serverMuted={memberOf(userId)?.serverMuted}
          live={screen.status === 'live'}
          picture={memberOf(userId)?.user.avatar}
          video={camera.stream}
          compact={hasStreams}
          menu={menuOf(userId)}
        />
      </li>
      {others.map((peer) => (
        <li key={peer.id} className={slotClass} style={slot}>
          <ParticipantTile
            name={peer.name}
            nameColor={colorOf(peer.userId)}
            speaking={speaking.includes(peer.id)}
            muted={peer.muted}
            deafened={peer.deafened}
            serverMuted={memberOf(peer.userId)?.serverMuted}
            live={isLive(peer)}
            watching={Boolean(watching[peer.id])}
            picture={memberOf(peer.userId)?.user.avatar}
            video={cameras[peer.id] ?? null}
            onVideoViewport={(cssHeight) => setCameraViewport(peer.id, cssHeight)}
            onWatch={() => watchStream(peer.id)}
            onUnwatch={() => unwatchStream(peer.id)}
            compact={hasStreams}
            volumeNote={volumeLabel(userVolumes[peer.userId] ?? 1)}
            menu={menuOf(peer.userId)}
          />
        </li>
      ))}
    </>
  );

  if (!hasStreams) {
    return (
      <div className="grid-bg h-full">
        <ul
          ref={setGrid}
          aria-label="Participantes"
          data-testid="participant-grid"
          style={{ gap: GAP }}
          className="flex h-full flex-wrap content-center items-center justify-center overflow-hidden p-3"
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
