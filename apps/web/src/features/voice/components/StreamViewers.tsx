import { useState } from 'react';
import { Icon } from '../../../components/Icon';
import { useVoiceStore } from '../voice-store';

/**
 * On the user's own share: how many people are watching it, and who, on hover or click. The
 * list comes from the media server, which knows who actually receives the video.
 */
export function StreamViewers() {
  const viewers = useVoiceStore((state) => state.screenViewers);
  const peers = useVoiceStore((state) => state.peers);
  const [pinned, setPinned] = useState(false);
  // Someone who left the call a moment ago may still be listed until the next update.
  const names = viewers
    .map((peerId) => peers[peerId]?.name)
    .filter((name): name is string => name !== undefined)
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const label =
    names.length === 0
      ? 'Ninguém está assistindo'
      : names.length === 1
        ? '1 pessoa assistindo'
        : `${names.length} pessoas assistindo`;

  return (
    <span className="group/viewers relative flex">
      <button
        type="button"
        aria-label={label}
        aria-expanded={pinned}
        data-testid="stream-viewers"
        data-count={names.length}
        className="label flex items-center gap-1 border-r border-b border-line bg-bg px-2 py-0.5 text-fg transition-colors hover:text-accent"
        onClick={(event) => {
          event.stopPropagation();
          setPinned((value) => !value);
        }}
      >
        <Icon name="eye" size={12} />
        {names.length}
      </button>
      <ul
        aria-label="Quem está assistindo"
        className={`absolute top-full left-0 z-10 min-w-36 border border-line-strong bg-surface-2 py-1 ${
          pinned ? 'block' : 'hidden group-hover/viewers:block'
        }`}
      >
        {names.length === 0 ? (
          <li className="label px-2 py-1 text-muted">NINGUÉM ASSISTINDO</li>
        ) : (
          names.map((name, index) => (
            <li key={`${name}-${index}`} className="truncate px-2 py-1 text-xs text-fg">
              {name}
            </li>
          ))
        )}
      </ul>
    </span>
  );
}
