import type { MenuEntry } from '../../../components/ContextMenu';
import { setUserVolume, useSettingsStore, useUserVolume } from '../../settings/settings-store';

/** iPhones and iPads do not let a page set the volume of an audio element, only silence it. */
const volumeIsFixed =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1));

function VolumeSlider({ userId, name }: { userId: string; name: string }) {
  const volume = useUserVolume(userId);
  if (volumeIsFixed) {
    return (
      <p className="text-xs text-muted">
        Este aparelho não deixa ajustar o volume de cada pessoa; dá para silenciar.
      </p>
    );
  }
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label text-muted">VOLUME PARA MIM — {Math.round(volume * 100)}%</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        aria-label={`Volume de ${name}`}
        className="w-full accent-(--accent)"
        onChange={(event) => setUserVolume(userId, Number(event.target.value))}
      />
    </label>
  );
}

/**
 * Menu entries to turn one person down, or off, for this user only. Nobody else hears a
 * difference and the person is not told.
 */
export function volumeMenuEntries(userId: string, name: string): MenuEntry[] {
  const silenced = (useSettingsStore.getState().userVolumes[userId] ?? 1) === 0;
  return [
    {
      type: 'custom',
      key: 'volume',
      render: () => <VolumeSlider userId={userId} name={name} />,
    },
    {
      label: silenced ? 'Voltar a ouvir' : 'Silenciar para mim',
      onSelect: () => setUserVolume(userId, silenced ? 1 : 0),
    },
  ];
}

/** Short label for a volume that is not the full one, e.g. on a participant's tile. */
export function volumeLabel(volume: number): string | null {
  if (volume >= 1) return null;
  return volume === 0 ? 'SILENCIADO' : `VOL ${Math.round(volume * 100)}%`;
}
