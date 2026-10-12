import { ghostDown } from '../../lib/exit-ghost';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { connectToVoiceChannel } from '../app/voice-channel';
import { useSettingsStore } from '../settings/settings-store';
import { ringWav } from '../sounds/tones';
import { useVoiceStore } from '../voice/voice-store';
import { useConversations } from './dm';
import { nextRinging, RING_TIMEOUT_MS, type CallState } from './incoming-calls';

const NO_CALLS: CallState = { friendIn: new Set(), selfIn: new Set() };

/** Plays the ring over and over while `active`, at the volume of the notification sounds. */
function useRingtone(active: boolean): void {
  const enabled = useSettingsStore((state) => state.soundsEnabled);
  const volume = useSettingsStore((state) => state.soundVolume);
  const deafened = useVoiceStore((state) => state.deafened);
  const audible = active && enabled && !deafened;

  useEffect(() => {
    if (!audible) return;
    const url = URL.createObjectURL(ringWav());
    const audio = new Audio(url);
    audio.loop = true;
    audio.volume = volume;
    // Browsers refuse sound before the first click on the page; the card still shows.
    void audio.play().catch(() => undefined);
    return () => {
      audio.pause();
      URL.revokeObjectURL(url);
    };
  }, [audible, volume]);
}

/**
 * A friend calling in a private conversation: a card with their name, a ring, and the choice
 * to answer or refuse. Shown wherever the user is in the app, since the conversation itself is
 * rarely on screen when the call comes.
 */
export function IncomingCalls({ selfId }: { selfId: string }) {
  const conversations = useConversations(selfId);
  const navigate = useNavigate();
  const [ringing, setRinging] = useState<ReadonlySet<string>>(new Set());
  const previous = useRef<CallState>(NO_CALLS);

  const inCall = (userId: string) =>
    conversations
      .filter(({ guild }) => guild.voiceStates.some((state) => state.userId === userId))
      .map(({ guild }) => guild.id)
      .sort();
  const friendKey = conversations
    .filter(({ guild, friend }) =>
      guild.voiceStates.some((state) => state.userId === friend.user.id),
    )
    .map(({ guild }) => guild.id)
    .sort()
    .join(',');
  const selfKey = inCall(selfId).join(',');

  useEffect(() => {
    const split = (key: string) => new Set(key ? key.split(',') : []);
    const next: CallState = { friendIn: split(friendKey), selfIn: split(selfKey) };
    const before = previous.current;
    previous.current = next;
    setRinging((current) => nextRinging(current, before, next));
  }, [friendKey, selfKey]);

  // A call nobody answers stops ringing by itself.
  const ringingKey = [...ringing].sort().join(',');
  useEffect(() => {
    if (!ringingKey) return;
    const timer = setTimeout(() => setRinging(new Set()), RING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [ringingKey]);

  useRingtone(ringing.size > 0);

  const calls = conversations.filter(({ guild, voice }) => voice && ringing.has(guild.id));
  if (calls.length === 0) return null;
  const dismiss = (guildId: string) =>
    setRinging((current) => new Set([...current].filter((id) => id !== guildId)));

  return (
    <div className="fixed top-3 right-3 z-40 flex w-72 max-w-[calc(100vw-1.5rem)] flex-col gap-2">
      {calls.map(({ guild, friend, voice }) => (
        <aside
          key={guild.id}
          ref={ghostDown}
          role="alertdialog"
          aria-label={`Chamada de ${friend.user.displayName}`}
          data-testid="incoming-call"
          className="anim-pop flex flex-col gap-3 border border-accent bg-surface p-3"
        >
          <div className="flex items-center gap-2">
            <Avatar name={friend.user.displayName} picture={friend.user.avatar} size={32} />
            <div className="min-w-0">
              <p className="label text-accent">CHAMADA</p>
              <p className="label-lg truncate text-fg">{friend.user.displayName}</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                if (!voice) return;
                dismiss(guild.id);
                connectToVoiceChannel(voice);
                navigate(`/app/${guild.id}/${voice.id}`);
              }}
            >
              ATENDER
            </Button>
            <Button variant="danger" onClick={() => dismiss(guild.id)}>
              RECUSAR
            </Button>
          </div>
        </aside>
      ))}
    </div>
  );
}
