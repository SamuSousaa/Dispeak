import { useVoiceStore } from '../voice-store';
import { ParticipantTile } from './ParticipantTile';

/** Main area of a voice channel: every participant as a tile. */
export function VoiceStage({ selfName }: { selfName: string }) {
  const selfId = useVoiceStore((state) => state.selfId);
  const muted = useVoiceStore((state) => state.muted);
  const deafened = useVoiceStore((state) => state.deafened);
  const peers = useVoiceStore((state) => state.peers);
  const speaking = useVoiceStore((state) => state.speaking);

  const others = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));

  return (
    <div className="grid-bg h-full overflow-y-auto p-3">
      <ul
        aria-label="Participantes"
        className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(220px,1fr))]"
      >
        <li>
          <ParticipantTile
            name={selfName}
            isSelf
            speaking={selfId !== null && speaking.includes(selfId)}
            muted={muted}
            deafened={deafened}
          />
        </li>
        {others.map((peer) => (
          <li key={peer.id}>
            <ParticipantTile
              name={peer.name}
              speaking={speaking.includes(peer.id)}
              muted={peer.muted}
              deafened={peer.deafened}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
