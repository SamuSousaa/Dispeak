import type { Guild } from '@frequencia/shared';
import { useState, type ReactNode } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../lib/cx';
import { setStageLayout, useUiStore } from '../../app/ui-store';
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

/** What has the main area to itself: one stream, or one person's camera. */
type Focus = { kind: 'stream' | 'person'; id: string };

/** The local user in the list of people, who has no session id of their own in the store. */
const SELF_PERSON = 'self';

const gridColumns = (count: number) =>
  count <= 1
    ? 'grid-cols-1'
    : count <= 4
      ? 'grid-cols-1 md:grid-cols-2'
      : 'grid-cols-2 lg:grid-cols-3';

const GAP = 12;

/**
 * Main area of a voice channel, in one of three arrangements:
 *
 * - grid: everyone, and every stream being watched, as equal tiles as large as fit. This is
 *   what a call without streams looks like, and what the user can ask for at any time;
 * - stage: the streams take the main area and the people line up in a strip below;
 * - focus: one stream or one camera, picked by the user, has the main area to itself and
 *   everything else goes to the strip.
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
  const layout = useUiStore((state) => state.stageLayout);
  const [focus, setFocus] = useState<Focus | null>(null);
  // Kept in state, not in a ref: the grid is unmounted while the stage is on screen, and when
  // it comes back the tiles must be sized again.
  const [grid, setGrid] = useState<HTMLUListElement | null>(null);

  const memberOf = (id: string | undefined) => guild?.members.find((entry) => entry.user.id === id);
  const colorOf = (id: string | undefined) => (guild && id ? memberColor(guild, id) : undefined);
  const menuOf = (targetId: string | undefined) =>
    guild && userId && targetId
      ? userMenu({ guild, targetId, selfId: userId, onManageMembers })
      : undefined;
  const others = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

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

  // A focus only holds while its subject is there: the stream still watched, the camera still on.
  const focusedStream =
    focus?.kind === 'stream' ? streams.find((stream) => stream.id === focus.id) : undefined;
  const cameraOf = (id: string) => (id === SELF_PERSON ? camera.stream : (cameras[id] ?? null));
  const focusedPerson =
    focus?.kind === 'person' && cameraOf(focus.id) && (focus.id === SELF_PERSON || peers[focus.id])
      ? focus.id
      : null;
  const focused = Boolean(focusedStream) || focusedPerson !== null;
  const hasStreams = streams.length > 0;
  // With nothing to put on a stage, the grid is all there is.
  const mode = focused ? 'focus' : hasStreams && layout === 'stage' ? 'stage' : 'grid';
  const compact = mode !== 'grid';

  const tileCount = others.length + 1 + streams.length;
  const cell = useFillGrid(grid, tileCount, 16 / 9, GAP);
  // Until the grid has been measured the tiles fall back to a plain 16:9 box.
  const measured = cell.width > 0 && cell.height > 0;
  const slot = compact || !measured ? undefined : { width: cell.width, height: cell.height };
  const slotClass = compact ? 'h-full' : measured ? 'shrink-0' : 'aspect-video w-full max-w-xl';

  const toggleFocus = (next: Focus) =>
    setFocus((current) => (current?.kind === next.kind && current.id === next.id ? null : next));

  const streamTile = (stream: StageStream, thumbnail = false) => (
    <StreamTile
      key={stream.id}
      id={stream.id}
      name={stream.name}
      stream={stream.stream}
      hasAudio={stream.hasAudio ?? false}
      focused={stream.id === focusedStream?.id}
      compact={thumbnail}
      onToggleFocus={() => toggleFocus({ kind: 'stream', id: stream.id })}
      onClose={() => (stream.id === SELF_STREAM ? stopScreenShare() : unwatchStream(stream.id))}
    />
  );

  const personTile = (id: string, large = false) => {
    const small = compact && !large;
    const onToggleFocus = () => toggleFocus({ kind: 'person', id });
    if (id === SELF_PERSON) {
      return (
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
          compact={small}
          focused={large}
          onToggleFocus={onToggleFocus}
          menu={menuOf(userId)}
        />
      );
    }
    const peer = peers[id];
    if (!peer) return null;
    return (
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
        compact={small}
        focused={large}
        onToggleFocus={onToggleFocus}
        volumeNote={volumeLabel(userVolumes[peer.userId] ?? 1)}
        menu={menuOf(peer.userId)}
      />
    );
  };

  const people = [SELF_PERSON, ...others.map((peer) => peer.id)];

  // Only a call with streams has two ways of being laid out.
  const layoutSwitch = (hasStreams || focused) && (
    <div className="absolute top-3 right-14 z-10 bg-bg" data-testid="stage-layout">
      <Button
        aria-pressed={mode === 'grid'}
        variant={mode === 'grid' ? 'active' : 'default'}
        title={
          mode === 'grid'
            ? 'Voltar a dar o espaço principal às transmissões'
            : 'Ver todo mundo e as transmissões em quadros do mesmo tamanho'
        }
        onClick={() => {
          setFocus(null);
          setStageLayout(mode === 'grid' ? 'stage' : 'grid');
        }}
      >
        {mode === 'grid' ? 'DESTACAR' : 'VER TODOS'}
      </Button>
    </div>
  );

  if (mode === 'grid') {
    return (
      <div className="grid-bg relative h-full">
        {layoutSwitch}
        <ul
          ref={setGrid}
          aria-label="Participantes"
          data-testid="participant-grid"
          style={{ gap: GAP }}
          className="flex h-full flex-wrap content-center items-center justify-center overflow-hidden p-3"
        >
          {streams.map((stream) => (
            <li key={`stream:${stream.id}`} className={slotClass} style={slot}>
              {streamTile(stream)}
            </li>
          ))}
          {people.map((id) => (
            <li key={id} className={slotClass} style={slot}>
              {personTile(id)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  let main: ReactNode;
  if (focusedStream) main = streamTile(focusedStream);
  else if (focusedPerson !== null) main = personTile(focusedPerson, true);
  else {
    main = (
      <div className={cx('grid h-full auto-rows-fr gap-3', gridColumns(streams.length))}>
        {streams.map((stream) => streamTile(stream))}
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {layoutSwitch}
      <div className="min-h-0 flex-1 p-3">{main}</div>
      <ul
        aria-label="Participantes"
        className="flex h-32 shrink-0 gap-3 overflow-x-auto border-t border-line bg-surface p-3"
      >
        {/* Next to a focus, the other streams wait in the strip as thumbnails. */}
        {focused &&
          streams
            .filter((stream) => stream.id !== focusedStream?.id)
            .map((stream) => (
              <li key={`stream:${stream.id}`} className="aspect-video h-full shrink-0">
                {streamTile(stream, true)}
              </li>
            ))}
        {people
          .filter((id) => id !== focusedPerson)
          .map((id) => (
            <li key={id} className={slotClass}>
              {personTile(id)}
            </li>
          ))}
      </ul>
    </div>
  );
}
