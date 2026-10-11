import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { desktop } from '../../desktop/desktop';
import { SCREEN_PRESET_LIST, SCREEN_PRESETS } from '../screen-presets';
import { startScreenShare, stopScreenShare } from '../voice-actions';
import { useVoiceStore } from '../voice-store';

/** Starts a screen share after picking a quality preset, or stops the running one. */
export function ScreenShareButton({ allowed = true }: { allowed?: boolean }) {
  const screen = useVoiceStore((state) => state.screen);
  const connected = useVoiceStore((state) => state.status === 'connected');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const supported = typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (screen.status === 'live') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="active" onClick={stopScreenShare}>
          PARAR TRANSMISSÃO
        </Button>
        <span className="label text-muted" data-testid="screen-preset">
          {screen.preset ? SCREEN_PRESETS[screen.preset].label : ''}
        </span>
        {!screen.hasAudio && (
          <span role="status" className="label text-danger" data-testid="screen-no-audio">
            SEM ÁUDIO DO SISTEMA
          </span>
        )}
        {screen.echoRisk && (
          <span role="status" className="label text-danger" data-testid="screen-echo-risk">
            QUEM ASSISTE PODE OUVIR A PRÓPRIA VOZ — TRANSMITA UMA ABA EM VEZ DA TELA INTEIRA
          </span>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative flex flex-wrap items-center gap-2">
      <Button
        variant="primary"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!supported || !allowed || !connected || screen.status === 'starting'}
        title={
          !supported
            ? 'Este navegador não permite capturar a tela'
            : !allowed
              ? 'Você não tem permissão para transmitir neste canal'
              : undefined
        }
        onClick={() => setOpen((value) => !value)}
      >
        TRANSMITIR
      </Button>
      {open && (
        <ul
          role="menu"
          aria-label="Qualidade da transmissão"
          className="anim-pop absolute bottom-full left-0 z-10 mb-2 w-72 border border-line-strong bg-surface-2"
        >
          {SCREEN_PRESET_LIST.map((preset) => (
            <li key={preset.id} role="none" className="border-b border-line last:border-b-0">
              <button
                type="button"
                role="menuitem"
                className="group flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface"
                onClick={() => {
                  setOpen(false);
                  startScreenShare(preset.id);
                }}
              >
                <span className="label-lg text-fg transition-colors group-hover:text-accent">
                  {preset.label}
                </span>
                <span className="text-xs text-muted">{preset.hint}</span>
              </button>
            </li>
          ))}
          {!desktop && (
            <li role="none" className="px-3 py-2">
              <Link
                to="/download"
                role="menuitem"
                className="text-xs text-muted underline underline-offset-4 transition-colors hover:text-accent"
              >
                Vai transmitir um jogo? O app para Windows mantém mais quadros por segundo.
              </Link>
            </li>
          )}
        </ul>
      )}
      {screen.error && (
        <span role="alert" className="label text-danger">
          {screen.error}
        </span>
      )}
    </div>
  );
}
