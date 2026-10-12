import { useState } from 'react';

/** Length of one pass of the trace, the same as `boot-trace` in `index.html`. */
const TRACE_MS = 1800;

/** Things worth knowing, one per start. Every one of them is true of the app as it is. */
const TIPS = [
  'Clique com o botão direito em alguém para ajustar o volume só para você.',
  'Clique com o botão direito em alguém de um servidor para adicionar como amigo.',
  'Nenhum atalho vem definido: escolha os seus em Configurações → ATALHOS.',
  'No app de desktop, atalhos com Ctrl ou Alt funcionam com um jogo em foco.',
  'A supressão de ruído liga e desliga pelo botão ao lado de desligar, durante a chamada.',
  'O olho na sua transmissão mostra quem está assistindo.',
  'Dois cliques em uma transmissão abrem a tela cheia.',
];

export interface BootStep {
  name: string;
  /** What is happening to it right now, as it is: `OK`, `CONECTANDO`. */
  state: string;
  done: boolean;
}

/**
 * The opening screen: the mark being traced like a signal, and what the app is waiting for.
 * `index.html` paints the same mark before any script runs, so this takes over without a jump.
 * With `leaving`, it switches off like a screen and tells when it is gone.
 */
export function BootScreen({
  steps,
  leaving = false,
  onGone,
}: {
  steps: BootStep[];
  leaving?: boolean;
  onGone?: () => void;
}) {
  // The trace keeps its beat across the screens that show it one after the other.
  const [delay] = useState(() => -(performance.now() % TRACE_MS));
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);

  return (
    <div
      className="boot"
      data-leaving={leaving || undefined}
      data-testid="boot-screen"
      role="status"
      aria-label="Abrindo o Dispeaker"
      onAnimationEnd={(event) => {
        if (leaving && event.target === event.currentTarget) onGone?.();
      }}
    >
      <svg className="boot-mark" viewBox="0 0 32 32" aria-hidden="true">
        <path className="boot-rest" pathLength={100} d="M5 16h4l3-9 5 18 4-13 2 4h4" />
        <path
          className="boot-trace"
          pathLength={100}
          d="M5 16h4l3-9 5 18 4-13 2 4h4"
          style={{ animationDelay: `${delay}ms` }}
        />
      </svg>
      <div className="boot-status">
        <dl className="label grid grid-cols-[auto_auto] gap-x-4 gap-y-1">
          {steps.map((step) => (
            <div key={step.name} className="contents">
              <dt className="text-muted">{step.name}</dt>
              <dd className={step.done ? 'text-accent' : 'boot-pending text-fg'}>{step.state}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 max-w-xs text-center text-xs text-muted">{tip}</p>
      </div>
    </div>
  );
}
