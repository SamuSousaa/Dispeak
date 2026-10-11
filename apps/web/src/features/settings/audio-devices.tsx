import { useEffect, useState } from 'react';
import { Field } from '../../components/Dialog';

export const supportsOutputSelection =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  cameras: MediaDeviceInfo[];
}

/** Audio devices the browser exposes. Names stay empty until microphone access is granted. */
export function useAudioDevices(refreshKey: unknown): AudioDevices {
  const [devices, setDevices] = useState<AudioDevices>({ inputs: [], outputs: [], cameras: [] });

  useEffect(() => {
    const media = navigator.mediaDevices;
    if (typeof media?.enumerateDevices !== 'function') return;
    let cancelled = false;
    const refresh = () => {
      media
        .enumerateDevices()
        .then((all) => {
          if (cancelled) return;
          // Chrome lists aliases of the system default; "Padrão do sistema" already covers them.
          const real = all.filter(
            (device) => device.deviceId !== 'default' && device.deviceId !== 'communications',
          );
          setDevices({
            inputs: real.filter((device) => device.kind === 'audioinput'),
            outputs: real.filter((device) => device.kind === 'audiooutput'),
            cameras: real.filter((device) => device.kind === 'videoinput'),
          });
        })
        .catch(() => undefined);
    };
    refresh();
    media.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      media.removeEventListener('devicechange', refresh);
    };
  }, [refreshKey]);

  return devices;
}

export function DeviceSelect({
  label,
  hint,
  value,
  devices,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string | null;
  devices: MediaDeviceInfo[];
  onChange: (deviceId: string | null) => void;
}) {
  const named = devices.filter((device) => device.deviceId && device.label);
  // A saved device that is unplugged right now still shows up, so the choice is not lost.
  const missing = value !== null && !named.some((device) => device.deviceId === value);
  return (
    <Field label={label} hint={hint}>
      <select
        className="field"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Padrão do sistema</option>
        {named.map((device) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label}
          </option>
        ))}
        {missing && <option value={value}>Dispositivo salvo (desconectado)</option>}
      </select>
    </Field>
  );
}
