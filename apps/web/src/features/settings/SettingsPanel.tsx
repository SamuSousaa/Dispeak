import type { Guild, Self } from '@frequencia/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../components/Button';
import { Dialog, Field } from '../../components/Dialog';
import { cx } from '../../lib/cx';
import { SOUND_EVENTS, SOUND_LABELS, type SoundEvent } from '../sounds/sound-events';
import {
  clearCustomSound,
  CUSTOM_SOUND_MAX_BYTES,
  playSound,
  setCustomSound,
} from '../sounds/sound-player';
import {
  canCloseToTray,
  desktop,
  useNativeCaptureCodec,
  useRefusedShortcuts,
} from '../desktop/desktop';
import type { NoiseEngine } from '../voice/microphone';
import { useVoiceStore } from '../voice/voice-store';
import { DeviceSelect, supportsOutputSelection, useAudioDevices } from './audio-devices';
import { bindingFromEvent, KEYBIND_ACTIONS, KEYBIND_LABELS, type KeybindAction } from './keybinds';
import {
  resetKeybinds,
  setKeybind,
  updateSettings,
  useSettingsStore,
  type InputMode,
} from './settings-store';
import { MicTest } from './MicTest';
import { PasswordForm, ProfileTab } from './ProfileTab';

const INPUT_OPTIONS: Array<{ value: InputMode; label: string; hint: string }> = [
  {
    value: 'voice',
    label: 'MICROFONE ABERTO',
    hint: 'Transmite sempre que você não estiver mutado.',
  },
  {
    value: 'pushToTalk',
    label: 'APERTAR PARA FALAR',
    hint: 'O microfone só abre enquanto você segura uma tecla.',
  },
];

export type SettingsTab =
  'profile' | 'voice' | 'video' | 'chat' | 'sounds' | 'keys' | 'app' | 'account';
type Tab = SettingsTab;

const NOISE_NAMES: Record<NoiseEngine, string> = {
  gtcrn: 'GTCRN',
  rnnoise: 'RNNOISE',
  browser: 'NAVEGADOR',
  off: 'DESLIGADA',
};

/** Phones and tablets: there is no keyboard to bind shortcuts to. */
const touchOnly =
  typeof window !== 'undefined' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

function Section({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-line">
      <h3 className="label border-b border-line bg-surface-2 px-4 py-2 text-fg">
        <span className="text-muted">{number}.</span> {title}
      </h3>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** Experimental: the desktop app captures the screen itself instead of the browser. */
function NativeCaptureSection() {
  const enabled = useSettingsStore((state) => state.nativeCapture);
  const codec = useNativeCaptureCodec();
  return (
    <Section number="02" title="TRANSMISSÃO">
      <Toggle
        label="CAPTURA NATIVA (EXPERIMENTAL)"
        hint="O app captura e comprime a tela direto na placa de vídeo, sem passar pelo navegador: com jogo pesado, mantém os quadros que a captura comum perde. Transmite sempre o monitor principal inteiro, na resolução dele, e você não vê a prévia da própria transmissão. Quem assiste precisa de um aparelho que reproduza AV1."
        checked={enabled}
        onChange={(nativeCapture) => updateSettings({ nativeCapture })}
      />
      {codec !== undefined && (
        <p className="label text-muted" data-testid="native-capture-status">
          {codec
            ? `DISPONÍVEL NESTE PC: ${codec.toUpperCase()}`
            : 'INDISPONÍVEL NESTE PC: PRECISA DE PLACA AMD OU NVIDIA E DO APP 0.7.1 OU MAIS NOVO'}
        </p>
      )}
    </Section>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
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
        <span className="text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}

/** A short list of exclusive choices, each with a line explaining it. */
function OptionGroup<T extends string>({
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

function KeybindRow({
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

function SoundRow({ event }: { event: SoundEvent }) {
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

/** Personal settings docked to the right, one tab per subject. */
export function SettingsPanel({
  user,
  guild,
  initialTab = 'voice',
  onSignOut,
  onClose,
}: {
  user: Self;
  /** The server on screen, for the nickname the user has in it. */
  guild?: Guild;
  initialTab?: SettingsTab;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const settings = useSettingsStore();
  const voiceStatus = useVoiceStore((state) => state.status);
  const micAvailable = useVoiceStore((state) => state.micAvailable);
  const activeNoise = useVoiceStore((state) => state.noiseSuppression);
  const cameraStatus = useVoiceStore((state) => state.camera.status);
  const devices = useAudioDevices(`${voiceStatus}:${micAvailable}:${cameraStatus}`);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [capturing, setCapturing] = useState<KeybindAction | null>(null);
  const refused = useRefusedShortcuts();

  const namesHidden = devices.inputs.length > 0 && devices.inputs.every((device) => !device.label);
  // Anything but the first-choice model means that one could not run here.
  const fellBack = settings.noiseSuppression && activeNoise !== null && activeNoise !== 'gtcrn';

  useEffect(() => {
    if (!capturing) return;
    // Capture phase, so the key neither closes the dialog nor triggers the shortcut it replaces.
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const binding = bindingFromEvent(event);
      if (!binding) return;
      setKeybind(capturing, binding);
      setCapturing(null);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing]);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'profile', label: 'PERFIL' },
    { id: 'voice', label: 'VOZ' },
    { id: 'video', label: 'VÍDEO' },
    { id: 'chat', label: 'CHAT' },
    { id: 'sounds', label: 'SONS' },
    { id: 'keys', label: 'ATALHOS' },
    // Only inside the desktop app: a browser tab has nothing of the kind to offer.
    ...(canCloseToTray ? [{ id: 'app' as const, label: 'APP' }] : []),
    { id: 'account', label: 'CONTA' },
  ];
  const notificationsBlocked =
    typeof Notification !== 'undefined' && Notification.permission === 'denied';

  const toggleNotifications = async (enabled: boolean) => {
    if (enabled && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      // The browser asks once; a refusal leaves the option off.
      if ((await Notification.requestPermission()) !== 'granted') return;
    }
    updateSettings({ desktopNotifications: enabled });
  };

  return (
    <Dialog side title="Configurações" eyebrow="SUAS PREFERÊNCIAS" onClose={onClose}>
      <div role="tablist" className="flex overflow-x-auto border-b border-line">
        {tabs.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => {
              setCapturing(null);
              setTab(entry.id);
            }}
            className={cx(
              'label shrink-0 border-b-2 px-2.5 py-2.5 transition-colors',
              tab === entry.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div key={tab} className="anim-view">
        {tab === 'voice' && (
          <>
            <Section number="01" title="ENTRADA">
              <DeviceSelect
                label="MICROFONE"
                hint={
                  namesHidden
                    ? 'Entre em um canal de voz e permita o microfone para ver os nomes dos dispositivos.'
                    : undefined
                }
                value={settings.inputDeviceId}
                devices={devices.inputs}
                onChange={(inputDeviceId) => updateSettings({ inputDeviceId })}
              />

              {!touchOnly && (
                <fieldset className="flex flex-col gap-1.5">
                  <legend className="label mb-1.5 text-muted">MODO DE ENTRADA</legend>
                  <OptionGroup
                    label="Modo de entrada"
                    name="input-mode"
                    value={settings.inputMode}
                    options={INPUT_OPTIONS}
                    onChange={(inputMode) => updateSettings({ inputMode })}
                  />
                  {settings.inputMode === 'pushToTalk' && (
                    <>
                      <ul>
                        <KeybindRow
                          action="pushToTalk"
                          capturing={capturing === 'pushToTalk'}
                          onCapture={setCapturing}
                        />
                      </ul>
                      <p
                        className={cx(
                          'text-xs',
                          settings.keybinds.pushToTalk ? 'text-muted' : 'text-danger',
                        )}
                      >
                        {settings.keybinds.pushToTalk
                          ? 'Funciona com esta aba em foco. Uma tecla que também escreve (uma letra, o espaço) não abre o microfone enquanto você digita no chat.'
                          : 'Escolha a tecla: sem ela, ninguém ouve você neste modo.'}
                      </p>
                    </>
                  )}
                </fieldset>
              )}

              <Toggle
                label="SUPRESSÃO DE RUÍDO"
                hint="Uma rede neural isola a sua voz e corta teclado, cliques, ventilador e vento. Também liga e desliga pelo botão ao lado de desligar, durante a chamada."
                checked={settings.noiseSuppression}
                onChange={(noiseSuppression) => updateSettings({ noiseSuppression })}
              />
              {activeNoise && (
                <p
                  className={cx('label', fellBack ? 'text-danger' : 'text-muted')}
                  data-testid="noise-active"
                >
                  {fellBack
                    ? `INDISPONÍVEL NESTE NAVEGADOR — EM USO: ${NOISE_NAMES[activeNoise]}`
                    : `EM USO AGORA: ${NOISE_NAMES[activeNoise]}`}
                </p>
              )}

              <Toggle
                label="NIVELAR E REFORÇAR A VOZ"
                hint="Deixa a voz em um volume firme e mais alto para quem ouve, sem estourar quando você fala alto."
                checked={settings.voiceLeveler}
                onChange={(voiceLeveler) => updateSettings({ voiceLeveler })}
              />
              <label className="flex flex-col gap-1.5">
                <span className="label text-muted">
                  VOLUME DO SEU MICROFONE — {Math.round(settings.micGain * 100)}%
                </span>
                <input
                  type="range"
                  min={0.5}
                  max={2}
                  step={0.05}
                  value={settings.micGain}
                  aria-label="Volume do seu microfone"
                  className="w-full accent-(--accent)"
                  onChange={(event) => updateSettings({ micGain: Number(event.target.value) })}
                />
                <span className="text-xs text-muted">
                  É o volume com que os outros ouvem você. Aumente se disserem que você está baixo.
                </span>
              </label>

              <Toggle
                label="CANCELAMENTO DE ECO"
                hint="Impede que o som das suas caixas volte pelo microfone."
                checked={settings.echoCancellation}
                onChange={(echoCancellation) => updateSettings({ echoCancellation })}
              />
              <Toggle
                label="GANHO AUTOMÁTICO"
                hint="Nivela o volume da sua voz."
                checked={settings.autoGainControl}
                onChange={(autoGainControl) => updateSettings({ autoGainControl })}
              />
              <MicTest />
            </Section>

            <Section number="02" title="SAÍDA">
              {supportsOutputSelection ? (
                <DeviceSelect
                  label="FONE / CAIXAS"
                  value={settings.outputDeviceId}
                  devices={devices.outputs}
                  onChange={(outputDeviceId) => updateSettings({ outputDeviceId })}
                />
              ) : (
                <p className="text-sm text-muted">
                  Este navegador não permite escolher a saída: o som sai pelo dispositivo padrão do
                  sistema.
                </p>
              )}
              <p className="text-xs text-muted">
                Para ajustar o volume de uma pessoa só para você, clique com o botão direito (ou
                segure o dedo) no nome dela.
              </p>
            </Section>
          </>
        )}

        {tab === 'video' && (
          <Section number="01" title="CÂMERA">
            <DeviceSelect
              label="CÂMERA"
              hint="Os nomes aparecem depois que você liga a câmera uma vez e permite o acesso."
              value={settings.cameraDeviceId}
              devices={devices.cameras}
              onChange={(cameraDeviceId) => updateSettings({ cameraDeviceId })}
            />
          </Section>
        )}

        {tab === 'chat' && (
          <>
            <Section number="01" title="MENSAGENS">
              <Toggle
                label="MOSTRAR PRÉVIAS E IMAGENS DE LINKS"
                hint="GIFs e imagens de links aparecem na conversa. Elas vêm direto do site de origem, que fica sabendo o seu endereço IP."
                checked={settings.showEmbeds}
                onChange={(showEmbeds) => updateSettings({ showEmbeds })}
              />
            </Section>
            <Section number="02" title="AVISOS">
              {typeof Notification === 'undefined' ? (
                <p className="text-sm text-muted">
                  Este navegador não mostra notificações do sistema. As menções continuam aparecendo
                  na lista de canais e no título da aba.
                </p>
              ) : (
                <>
                  <Toggle
                    label="NOTIFICAR MENÇÕES"
                    hint="Aviso do sistema quando alguém menciona ou responde você e esta aba não está em primeiro plano."
                    checked={settings.desktopNotifications && !notificationsBlocked}
                    onChange={(enabled) => void toggleNotifications(enabled)}
                  />
                  {notificationsBlocked && (
                    <p className="label text-danger">
                      AS NOTIFICAÇÕES ESTÃO BLOQUEADAS PARA ESTE SITE NO NAVEGADOR
                    </p>
                  )}
                </>
              )}
            </Section>
          </>
        )}

        {tab === 'sounds' && (
          <Section number="01" title="SONS DE NOTIFICAÇÃO">
            <Toggle
              label="TOCAR SONS"
              hint="Avisos sonoros do canal de voz em que você está."
              checked={settings.soundsEnabled}
              onChange={(soundsEnabled) => updateSettings({ soundsEnabled })}
            />
            <Field label={`VOLUME — ${Math.round(settings.soundVolume * 100)}%`}>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                className="w-full accent-(--accent)"
                value={settings.soundVolume}
                onChange={(change) => updateSettings({ soundVolume: Number(change.target.value) })}
              />
            </Field>
            <ul className="flex flex-col gap-3">
              {SOUND_EVENTS.map((event) => (
                <SoundRow key={event} event={event} />
              ))}
            </ul>
            <p className="text-xs text-muted">
              Os arquivos escolhidos aqui ficam guardados só neste navegador. Quando o dono de um
              servidor define um som, é o dele que toca para todos naquele servidor. Sons não tocam
              enquanto você está ensurdecido.
            </p>
          </Section>
        )}

        {tab === 'keys' && (
          <Section number="01" title="ATALHOS DE TECLADO">
            {touchOnly ? (
              <p className="text-sm text-muted">
                Atalhos precisam de um teclado. Neste aparelho, use os botões de microfone e fone.
              </p>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {KEYBIND_ACTIONS.map((action) => (
                    <KeybindRow
                      key={action}
                      action={action}
                      capturing={capturing === action}
                      onCapture={setCapturing}
                    />
                  ))}
                </ul>
                <p className="text-xs text-muted">
                  Nenhum atalho vem definido: clique em um e pressione a tecla (Esc cancela).
                  Atalhos de uma tecla só não valem enquanto você digita; combine com Ctrl ou Alt
                  para valerem sempre. “Apertar para falar” só vale com esse modo ligado na aba VOZ.
                </p>
                <p className="text-xs text-muted">
                  {desktop
                    ? 'No app, atalhos com Ctrl ou Alt e as teclas F1 a F24 funcionam também com um jogo em foco, para mutar, ensurdecer, transmitir, câmera e desligar. Os demais valem com a janela do Dispeaker em foco.'
                    : 'No navegador, funcionam com esta aba em foco. No app de desktop, atalhos com Ctrl ou Alt funcionam também com um jogo em foco.'}
                </p>
                {refused.length > 0 && (
                  <p className="text-xs text-danger" data-testid="refused-shortcuts">
                    Outro programa já usa:{' '}
                    {refused
                      .map((action) => KEYBIND_LABELS[action as KeybindAction] ?? action)
                      .join(', ')}
                    . Escolha outra combinação.
                  </p>
                )}
                <Button
                  className="self-start"
                  onClick={() => {
                    setCapturing(null);
                    resetKeybinds();
                  }}
                >
                  REMOVER TODOS
                </Button>
              </>
            )}
          </Section>
        )}

        {tab === 'app' && desktop && (
          <Section number="01" title="JANELA">
            <Toggle
              label="O BOTÃO X MINIMIZA PARA A BANDEJA"
              hint="Fechar a janela esconde o Dispeaker nos ícones ao lado do relógio em vez de sair: a chamada continua e os atalhos seguem valendo. Clique no ícone para voltar; para sair de vez, clique nele com o botão direito e escolha Sair."
              checked={settings.closeToTray}
              onChange={(closeToTray) => updateSettings({ closeToTray })}
            />
            <p className="label text-muted" data-testid="desktop-version">
              VERSÃO DO APP: {desktop.version}
            </p>
          </Section>
        )}
        {tab === 'app' && desktop?.nativeCapture && <NativeCaptureSection />}

        {tab === 'profile' && <ProfileTab key={user.id} user={user} guild={guild} />}

        {tab === 'account' && (
          <>
            <Section number="01" title="SENHA">
              <PasswordForm onChanged={onSignOut} />
            </Section>
            <Section number="02" title="SESSÃO">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="label-lg truncate text-fg">{user.displayName}</p>
                  <p className="label truncate text-muted">@{user.username}</p>
                </div>
                <Button variant="danger" onClick={onSignOut}>
                  SAIR DA CONTA
                </Button>
              </div>
            </Section>
          </>
        )}
      </div>
    </Dialog>
  );
}
