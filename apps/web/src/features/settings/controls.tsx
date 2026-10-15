import { useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../lib/cx';
import { SOUND_LABELS, type SoundEvent } from '../sounds/sound-events';
import {
  clearCustomSound,
  CUSTOM_SOUND_MAX_BYTES,
  playSound,
  setCustomSound,
} from '../sounds/sound-player';
import { KEYBIND_LABELS, type KeybindAction } from './keybinds';
import { setKeybind, updateSettings, useSettingsStore } from './settings-store';

/** The building blocks of the settings pages. */

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-(--accent)"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex min-w-0 flex-col">
        <span className="label text-fg">{label}</span>
        {hint && <span className="text-xs text-muted">{hint}</span>}
      </span>
    </label>
  );
}

/** A slider with its value in the label, for volumes. */
export function Slider({
  label,
  hint,
  value,
  min = 0,
  max = 1,
  step = 0.05,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label text-muted">
        {label} — {Math.round(value * 100)}%
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        className="w-full accent-(--accent)"
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

/** A short list of exclusive choices, each with a line explaining it. */
export function OptionGroup<T extends string>({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: T;
  options: Array<{ value: T; label: string; hint: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex flex-col gap-px border border-line bg-line"
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <label
            key={option.value}
            className={cx(
              'flex cursor-pointer flex-col gap-0.5 border-l-2 bg-surface px-3 py-2 transition-colors',
              'has-focus-visible:outline-2 has-focus-visible:outline-accent',
              selected ? 'border-accent bg-surface-2' : 'border-transparent hover:bg-surface-2',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={selected}
              onChange={() => onChange(option.value)}
            />
            <span className={cx('label', selected ? 'text-accent' : 'text-fg')}>
              {option.label}
            </span>
            <span className="text-xs text-muted">{option.hint}</span>
          </label>
        );
      })}
    </div>
  );
}

export function KeybindRow({
  action,
  capturing,
  onCapture,
}: {
  action: KeybindAction;
  capturing: boolean;
  onCapture: (action: KeybindAction | null) => void;
}) {
  const binding = useSettingsStore((state) => state.keybinds[action]);
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate text-sm text-fg">{KEYBIND_LABELS[action]}</span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Button
          bare
          variant={capturing ? 'active' : 'default'}
          className="min-w-24"
          aria-label={`Atalho de ${KEYBIND_LABELS[action]}: ${binding ?? 'nenhum'}. Alterar`}
          onClick={() => onCapture(capturing ? null : action)}
        >
          {capturing ? 'PRESSIONE…' : (binding ?? '—')}
        </Button>
        <Button
          bare
          disabled={binding === null}
          aria-label={`Remover atalho de ${KEYBIND_LABELS[action]}`}
          onClick={() => {
            onCapture(null);
            setKeybind(action, null);
          }}
        >
          X
        </Button>
      </span>
    </li>
  );
}

export function SoundRow({ event }: { event: SoundEvent }) {
  const enabled = useSettingsStore((state) => state.soundEvents[event]);
  const fileName = useSettingsStore((state) => state.customSounds[event]);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('audio/')) {
      setError('ESCOLHA UM ARQUIVO DE ÁUDIO (MP3, WAV, OGG).');
    } else if (file.size > CUSTOM_SOUND_MAX_BYTES) {
      setError('O ARQUIVO PODE TER ATÉ 2 MB.');
    } else {
      setError(null);
      await setCustomSound(event, file).catch(() =>
        setError('NÃO FOI POSSÍVEL GUARDAR O ARQUIVO.'),
      );
      void playSound(event);
    }
  };

  return (
    <li className="flex flex-col gap-1.5 border-b border-line pb-3 last:border-b-0 last:pb-0">
      <label className="flex cursor-pointer items-center gap-3">
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 accent-(--accent)"
          checked={enabled}
          onChange={(change) =>
            updateSettings({
              soundEvents: {
                ...useSettingsStore.getState().soundEvents,
                [event]: change.target.checked,
              },
            })
          }
        />
        <span className="min-w-0 text-sm text-fg">{SOUND_LABELS[event]}</span>
      </label>
      <p className="label truncate pl-7 text-muted" data-testid={`sound-file-${event}`}>
        {fileName ? `ARQUIVO: ${fileName}` : 'SOM PADRÃO'}
      </p>
      <div className="flex flex-wrap gap-1.5 pl-7">
        <input
          ref={input}
          type="file"
          accept="audio/*"
          hidden
          data-testid={`sound-input-${event}`}
          onChange={(change) => {
            void choose(change.target.files?.[0]);
            change.target.value = '';
          }}
        />
        <Button
          aria-label={`Testar som: ${SOUND_LABELS[event]}`}
          onClick={() => void playSound(event)}
        >
          TESTAR
        </Button>
        <Button
          aria-label={`Escolher arquivo para: ${SOUND_LABELS[event]}`}
          onClick={() => input.current?.click()}
        >
          ESCOLHER ARQUIVO
        </Button>
        {fileName && (
          <Button
            variant="danger"
            aria-label={`Voltar ao som padrão: ${SOUND_LABELS[event]}`}
            onClick={() => void clearCustomSound(event)}
          >
            PADRÃO
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="label pl-7 text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
