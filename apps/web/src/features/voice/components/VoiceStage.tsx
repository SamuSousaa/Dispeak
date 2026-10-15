import type { Guild } from '@frequencia/shared';
import { useState } from 'react';
import { isContextMenuOpen } from '../../../components/ContextMenu';
import { memberColor, memberName } from '../../guilds/permissions';
import { userContextMenu } from '../../guilds/user-menu';
import { useAccountSettings } from '../../settings/account-settings';
import {
  setCameraViewport,
  stopScreenShare,
  unwatchStream,
  unwatchUser,
  watchStream,
} from '../voice-actions';
import { isLive, SELF_STREAM, useVoiceStore } from '../voice-store';
import { ParticipantTile } from './ParticipantTile';
import { StreamTile } from './StreamTile';
import { useFillGrid } from './use-fill-grid';
import { volumeLabel } from './VolumeControl';

interface StageStream {
  id: string;
  /** Absent for the local preview. */
  userId?: string;
  name: string;
  /** Ended, and waiting for the person to share again. */
  ended?: boolean;
  stream: MediaStream | null;
  /** Whether the streamer is sending the sound of what they share. */
  hasAudio?: boolean;
}

/** What has the main area to itself: one stream, or one person's camera. */
type Focus = { kind: 'stream' | 'person'; id: string };

/** The local user in the list of people, who has no session id of their own in the store. */
const SELF_PERSON = 'self';

const GAP = 12;

/**
 * Main area of a voice channel, in one of two arrangements:
 *
 * - grid: everyone, and every stream being watched, as equal tiles as large as fit;
 * - focus: one stream or one person has the main area to itself and everything else lines up
 *   in a strip below.
 *
 * A click on a tile gives it the focus, wherever it is; a click on the focused one goes back
 * to the grid. A stream the user starts watching takes the focus by itself.
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
  const wantedStreams = useVoiceStore((state) => state.wantedStreams);
  const preferences = useAccountSettings((settings) => settings.people);
  // Coming back to the call from another channel, a stream being watched is still the focus.
  const [focus, setFocus] = useState<Focus | null>(() => {
    const [id] = Object.keys(useVoiceStore.getState().watching);
    return id ? { kind: 'stream', id } : null;
  });
  // Kept in state, not in a ref: the grid is unmounted while the stage is on screen, and when
  // it comes back the tiles must be sized again.
  const [grid, setGrid] = useState<HTMLUListElement | null>(null);

  const memberOf = (id: string | undefined) => guild?.members.find((entry) => entry.user.id === id);
  const colorOf = (id: string | undefined) => (guild && id ? memberColor(guild, id) : undefined);
  // On the stage a click picks the focus; the person's menu is on the right click.
  const menuOf = (targetId: string | undefined) =>
    guild && userId && targetId
      ? userContextMenu({ guild, targetId, selfId: userId, onManageMembers })
      : undefined;
  const others = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  const selfName = guild && userId ? memberName(guild, userId) : (givenName ?? '');
  const streams: StageStream[] = [
    ...(screen.status === 'live'
      ? [{ id: SELF_STREAM, name: selfName, stream: screen.stream }]
      : []),
    ...others
      .filter((peer) => watching[peer.id] || (wantedStreams.includes(peer.userId) && !isLive(peer)))
      .map((peer) => ({
        id: peer.id,
        userId: peer.userId,
        name: peer.name,
        stream: watching[peer.id]?.stream ?? null,
        hasAudio: peer.producers.some((producer) => producer.source === 'screen-audio'),
        ended: !watching[peer.id],
      })),
  ];

  // A stream the user has just started watching is what they came for: it takes the focus.
  const watchedIds = streams
    .filter((stream) => stream.id !== SELF_STREAM)
    .map((stream) => stream.id)
    .join(' ');
  const [knownIds, setKnownIds] = useState(watchedIds);
  if (watchedIds !== knownIds) {
    const known = knownIds.split(' ');
    const added = watchedIds.split(' ').find((id) => id && !known.includes(id));
    setKnownIds(watchedIds);
    if (added) setFocus({ kind: 'stream', id: added });
  }

  // A focus only holds while its subject is there: the stream still watched, the person in the call.
  const focusedStream =
    focus?.kind === 'stream' ? streams.find((stream) => stream.id === focus.id) : undefined;
  const focusedPerson =
    focus?.kind === 'person' && (focus.id === SELF_PERSON || peers[focus.id]) ? focus.id : null;
  const focused = Boolean(focusedStream) || focusedPerson !== null;
  const compact = focused;

  const tileCount = others.length + 1 + streams.length;
  const cell = useFillGrid(grid, tileCount, 16 / 9, GAP);
  // Until the grid has been measured the tiles fall back to a plain 16:9 box.
  const measured = cell.width > 0 && cell.height > 0;
  const slot = compact || !measured ? undefined : { width: cell.width, height: cell.height };
  const slotClass = compact ? 'h-full' : measured ? 'shrink-0' : 'aspect-video w-full max-w-xl';

  const toggleFocus = (next: Focus) => {
    // A long press has just opened the person's menu; lifting the finger is not a click.
    if (isContextMenuOpen()) return;
    setFocus((current) => (current?.kind === next.kind && current.id === next.id ? null : next));
  };

  const streamTile = (stream: StageStream, thumbnail = false) => (
    <StreamTile
      key={stream.id}
      id={stream.id}
      userId={stream.userId}
      name={stream.name}
      ended={stream.ended ?? false}
      stream={stream.stream}
      hasAudio={stream.hasAudio ?? false}
      focused={stream.id === focusedStream?.id}
      compact={thumbnail}
      onToggleFocus={() => toggleFocus({ kind: 'stream', id: stream.id })}
      onClose={() =>
        stream.id === SELF_STREAM
          ? stopScreenShare()
          : stream.ended && stream.userId
            ? unwatchUser(stream.userId)
            : unwatchStream(stream.id)
      }
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
        volumeNote={volumeLabel(
          preferences[peer.userId]?.voiceMuted ? 0 : (preferences[peer.userId]?.voiceVolume ?? 1),
        )}
        menu={menuOf(peer.userId)}
      />
    );
  };

  const people = [SELF_PERSON, ...others.map((peer) => peer.id)];

  if (!focused) {
    return (
      <div className="grid-bg relative h-full">
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

  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1 p-3">
        {focusedStream
          ? streamTile(focusedStream)
          : focusedPerson !== null && personTile(focusedPerson, true)}
      </div>
      <ul
        aria-label="Participantes"
        className="flex h-32 shrink-0 gap-3 overflow-x-auto border-t border-line bg-surface p-3"
      >
        {/* Next to the focus, the other streams wait in the strip as thumbnails. */}
        {streams
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
