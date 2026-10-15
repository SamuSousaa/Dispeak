import type { MenuEntry } from '../../../components/ContextMenu';
import { changePerson, getPerson, usePerson } from '../../settings/account-settings';

/** iPhones and iPads do not let a page set the volume of an audio element, only silence it. */
export const volumeIsFixed =
  typeof navigator !== 'undefined' &&
  (/iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Mac') && navigator.maxTouchPoints > 1));

/** Which sound of a person: their voice, or the sound of their screen share. */
export type PersonSound = 'voice' | 'stream';

const fields = {
  voice: { volume: 'voiceVolume', muted: 'voiceMuted' },
  stream: { volume: 'streamVolume', muted: 'streamMuted' },
} as const;

/** How loud one sound of a person is for this user, mute included (0 to 1). */
export function useEffectiveVolume(userId: string, sound: PersonSound): number {
  const person = usePerson(userId);
  const field = fields[sound];
  return person[field.muted] ? 0 : person[field.volume];
}

/** Moving the volume also brings a muted sound back, as one would expect. */
export function setPersonVolume(userId: string, sound: PersonSound, volume: number): void {
  const field = fields[sound];
  changePerson(userId, { [field.volume]: volume, [field.muted]: false });
}

export function togglePersonMuted(userId: string, sound: PersonSound): void {
  const field = fields[sound];
  changePerson(userId, { [field.muted]: !getPerson(userId)[field.muted] });
}

function VolumeSlider({
  userId,
  name,
  sound,
}: {
  userId: string;
  name: string;
  sound: PersonSound;
}) {
  const person = usePerson(userId);
  const field = fields[sound];
  const volume = person[field.volume];
  if (volumeIsFixed) {
    return (
      <p className="text-xs text-muted">
        Este aparelho não deixa ajustar o volume de cada pessoa; dá para silenciar.
      </p>
    );
  }
  const what = sound === 'voice' ? 'VOLUME PARA MIM' : 'VOLUME DA TRANSMISSÃO';
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label text-muted">
        {what} — {person[field.muted] ? 'MUDO' : `${Math.round(volume * 100)}%`}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={volume}
        aria-label={sound === 'voice' ? `Volume de ${name}` : `Volume da transmissão de ${name}`}
        className="w-full accent-(--accent)"
        onChange={(event) => setPersonVolume(userId, sound, Number(event.target.value))}
      />
    </label>
  );
}

/**
 * Menu entries to turn one sound of a person down, or off, for this user only. Nobody else
 * hears a difference and the person is not told. The choice follows the account.
 */
export function volumeMenuEntries(
  userId: string,
  name: string,
  sound: PersonSound = 'voice',
): MenuEntry[] {
  const muted = getPerson(userId)[fields[sound].muted];
  const toggleLabel =
    sound === 'voice'
      ? muted
        ? 'Voltar a ouvir'
        : 'Silenciar para mim'
      : muted
        ? 'Ativar som da transmissão'
        : 'Mutar transmissão';
  return [
    {
      type: 'custom',
      key: `volume-${sound}`,
      render: () => <VolumeSlider userId={userId} name={name} sound={sound} />,
    },
    { label: toggleLabel, onSelect: () => togglePersonMuted(userId, sound) },
  ];
}

/** Short label for a volume that is not the full one, e.g. on a participant's tile. */
export function volumeLabel(volume: number): string | null {
  if (volume >= 1) return null;
  return volume === 0 ? 'SILENCIADO' : `VOL ${Math.round(volume * 100)}%`;
}
