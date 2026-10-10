import { useEffect, useState } from 'react';
import { Button } from '../../components/Button';
import { LevelBar } from '../voice/components/MicMeter';
import { meterTrack } from '../voice/level-meter';
import { openMicrophone } from '../voice/microphone';
import { useVoiceStore } from '../voice/voice-store';
import { useSettingsStore } from './settings-store';

/**
 * Lets the user see whether the microphone works, with the filters chosen above. In a call it
 * shows the level of what is being sent; outside one it opens the microphone just for the test
 * (nobody hears it).
 */
export function MicTest() {
  const inCall = useVoiceStore((state) => state.status === 'connected' && state.micAvailable);
  const callLevel = useVoiceStore((state) => state.micLevel);
  const muted = useVoiceStore((state) => state.muted);
  const inputDeviceId = useSettingsStore((state) => state.inputDeviceId);
  const noiseSuppression = useSettingsStore((state) => state.noiseSuppression);
  const echoCancellation = useSettingsStore((state) => state.echoCancellation);
  const autoGainControl = useSettingsStore((state) => state.autoGainControl);
  const noiseGate = useSettingsStore((state) => state.noiseGate);
  const noiseGateThreshold = useSettingsStore((state) => state.noiseGateThreshold);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!testing || inCall) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    openMicrophone({
      inputDeviceId,
      noiseSuppression,
      echoCancellation,
      autoGainControl,
      noiseGate,
      noiseGateThreshold,
    })
      .then((microphone) => {
        const stopMeter = meterTrack(microphone.track, setLevel);
        release = () => {
          stopMeter();
          microphone.close();
        };
        if (cancelled) release();
      })
      .catch((error: unknown) => {
        console.warn('[settings] microphone test failed', error);
        if (cancelled) return;
        setFailed(true);
        setTesting(false);
      });
    return () => {
      cancelled = true;
      release?.();
      setLevel(0);
    };
  }, [
    testing,
    inCall,
    inputDeviceId,
    noiseSuppression,
    echoCancellation,
    autoGainControl,
    noiseGate,
    noiseGateThreshold,
  ]);

  const shown = inCall ? (muted ? 0 : callLevel) : level;
  const active = inCall || testing;

  return (
    <div className="flex flex-col gap-2 border border-line p-3" data-testid="mic-test">
      <div className="flex flex-wrap items-center gap-3">
        <span className="label text-muted">TESTE DO MICROFONE</span>
        {active && <LevelBar level={shown} className="h-3" />}
        {!inCall && (
          <Button
            variant={testing ? 'active' : 'default'}
            aria-pressed={testing}
            className="ml-auto"
            onClick={() => {
              setFailed(false);
              setTesting((value) => !value);
            }}
          >
            {testing ? 'PARAR TESTE' : 'TESTAR'}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">
        {inCall
          ? muted
            ? 'Você está mutado: nada é enviado.'
            : 'As barras mostram o que os outros estão ouvindo de você agora.'
          : testing
            ? 'Fale: as barras devem acender. Digite: devem ficar apagadas. Ninguém ouve o teste.'
            : 'Mostra o nível do microfone depois dos filtros acima, sem entrar em uma chamada.'}
      </p>
      {failed && (
        <p role="alert" className="label text-danger">
          NÃO FOI POSSÍVEL ABRIR O MICROFONE
        </p>
      )}
    </div>
  );
}
