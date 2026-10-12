import { ghostDown } from '../../lib/exit-ghost';
import { Button } from '../../components/Button';
import { DeviceSelect, supportsOutputSelection, useAudioDevices } from '../settings/audio-devices';
import { updateSettings, useSettingsStore } from '../settings/settings-store';
import { LevelBar } from '../voice/components/MicMeter';
import { useVoiceStore } from '../voice/voice-store';

export type QuickAudioKind = 'input' | 'output';

function Volume({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label flex justify-between text-muted">
        <span>{label}</span>
        <span className="text-fg">{Math.round(value * 100)}%</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        aria-label={label}
        className="w-full accent-(--accent)"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

/** What the others receive from the microphone right now, as a row of segments. */
function InputLevel() {
  const connected = useVoiceStore((state) => state.status === 'connected');
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const muted = useVoiceStore((state) => state.muted);
  const pttHeld = useVoiceStore((state) => state.pttHeld);
  const level = useVoiceStore((state) => state.micLevel);
  const pushToTalk = useSettingsStore((state) => state.inputMode === 'pushToTalk');
  const closed = muted || (pushToTalk && !pttHeld);

  return (
    <div className="flex flex-col gap-1.5">
      <span className="label flex justify-between text-muted">
        <span>NÍVEL DE ENTRADA</span>
        {connected && micAvailable && (
          <span className={!closed && level > 0 ? 'text-accent' : undefined}>
            {muted ? 'MUTADO' : closed ? 'FECHADO' : level > 0 ? 'ENVIANDO' : 'SILÊNCIO'}
          </span>
        )}
      </span>
      {connected && micAvailable ? (
        <LevelBar level={closed ? 0 : level} segments={24} className="w-full" />
      ) : (
        <span className="text-xs text-muted">Entre em uma chamada para ver o nível.</span>
      )}
    </div>
  );
}

/**
 * The few audio settings worth changing in the middle of a call, one click away from the
 * microphone and the headphones buttons: device, volume and, for the microphone, its level.
 */
export function QuickAudio({
  kind,
  onOpenSettings,
}: {
  kind: QuickAudioKind;
  onOpenSettings: () => void;
}) {
  const voiceStatus = useVoiceStore((state) => state.status);
  const devices = useAudioDevices(voiceStatus);
  const inputDeviceId = useSettingsStore((state) => state.inputDeviceId);
  const outputDeviceId = useSettingsStore((state) => state.outputDeviceId);
  const micGain = useSettingsStore((state) => state.micGain);
  const outputVolume = useSettingsStore((state) => state.outputVolume);
  const namesHidden = devices.inputs.length > 0 && devices.inputs.every((device) => !device.label);

  return (
    <div
      ref={ghostDown}
      role="dialog"
      aria-label={kind === 'input' ? 'Entrada de áudio' : 'Saída de áudio'}
      data-testid={`quick-audio-${kind}`}
      className="anim-pop absolute right-2 bottom-full left-2 z-20 mb-2 flex flex-col gap-4 border border-line-strong bg-surface-2 p-3"
    >
      {kind === 'input' ? (
        <>
          <DeviceSelect
            label="DISPOSITIVO DE ENTRADA"
            hint={
              namesHidden
                ? 'Entre em uma chamada e permita o microfone para ver os nomes.'
                : undefined
            }
            value={inputDeviceId}
            devices={devices.inputs}
            onChange={(deviceId) => updateSettings({ inputDeviceId: deviceId })}
          />
          <Volume
            label="VOLUME DE ENTRADA"
            value={micGain}
            min={0.5}
            max={2}
            onChange={(value) => updateSettings({ micGain: value })}
          />
          <InputLevel />
        </>
      ) : (
        <>
          {supportsOutputSelection ? (
            <DeviceSelect
              label="DISPOSITIVO DE SAÍDA"
              value={outputDeviceId}
              devices={devices.outputs}
              onChange={(deviceId) => updateSettings({ outputDeviceId: deviceId })}
            />
          ) : (
            <p className="text-xs text-muted">
              Este navegador usa sempre a saída padrão do sistema.
            </p>
          )}
          <Volume
            label="VOLUME DE SAÍDA"
            value={outputVolume}
            min={0}
            max={1}
            onChange={(value) => updateSettings({ outputVolume: value })}
          />
        </>
      )}
      <Button className="self-start" onClick={onOpenSettings}>
        CONFIGURAÇÕES DE VOZ
      </Button>
    </div>
  );
}
