import type { MeetingState } from '@frequencia/shared';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { ContextMenuHost } from '../components/ContextMenu';
import { ToastHost } from '../components/Toast';
import { Field, FormError } from '../components/Dialog';
import { Metric } from '../components/LabLayout';
import { Loading } from '../components/Loading';
import { cx } from '../lib/cx';
import { useAuthStore } from '../features/auth/auth-store';
import {
  admit,
  cancelKnock,
  closeMeeting,
  deny,
  endMeeting,
  knock,
  leaveCall,
  openMeeting,
  rejoinCall,
  say,
  useMeetingStore,
} from '../features/meetings/meeting-store';
import { openPersonMenu, personMenu } from '../features/meetings/meeting-menu';
import { VoiceControls } from '../features/voice/components/VoiceControls';
import { VoiceStage } from '../features/voice/components/VoiceStage';
import { VoiceSystemBar } from '../features/voice/components/VoiceSystemBar';
import { useVoiceShortcuts } from '../features/voice/use-voice-shortcuts';
import { useVoiceStore } from '../features/voice/voice-store';

/**
 * A meeting, reached by its link: the door (a name, then waiting to be let in), then the call
 * with its people and its chat. Signed in or not.
 */
export function MeetingPage() {
  const { meetingId = '' } = useParams();
  const phase = useMeetingStore((state) => state.phase);

  useEffect(() => {
    void openMeeting(meetingId);
    return closeMeeting;
  }, [meetingId]);

  return (
    <>
      {phase === 'inside' || phase === 'left' ? <MeetingRoom /> : <MeetingDoor />}
      <ContextMenuHost />
      <ToastHost />
    </>
  );
}

/** The card everything outside the call is said in. */
function DoorCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="anim-view w-full max-w-sm border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">REUNIÃO · SOME QUANDO A CHAMADA ACABAR</p>
          <h1 className="display mt-1 text-2xl text-fg">{title}</h1>
        </header>
        <div className="flex flex-col gap-4 p-4">{children}</div>
      </section>
    </main>
  );
}

function MeetingDoor() {
  const phase = useMeetingStore((state) => state.phase);
  const preview = useMeetingStore((state) => state.preview);
  const error = useMeetingStore((state) => state.error);
  const busy = useMeetingStore((state) => state.busy);
  const user = useAuthStore((state) => state.user);
  const authStatus = useAuthStore((state) => state.status);
  const [name, setName] = useState('');

  if (phase === 'loading' || authStatus === 'loading') {
    return (
      <DoorCard title="…">
        <Loading label="PROCURANDO A REUNIÃO" />
      </DoorCard>
    );
  }
  if (phase === 'missing') {
    return (
      <DoorCard title="REUNIÃO ENCERRADA">
        <p className="text-sm text-muted">
          Esta reunião acabou ou não existe. Uma reunião some quando a chamada termina, com tudo o
          que foi dito no chat.
        </p>
        <Link to="/app" className="label text-muted transition-colors hover:text-accent">
          ← IR PARA O DISPEAKER
        </Link>
      </DoorCard>
    );
  }
  const host = preview?.hostName ?? '';
  if (phase === 'removed') {
    return (
      <DoorCard title="VOCÊ FOI REMOVIDO">
        <p className="text-sm text-muted">O anfitrião tirou você da reunião de {host}.</p>
        <Button onClick={cancelKnock}>PEDIR PARA ENTRAR DE NOVO</Button>
      </DoorCard>
    );
  }
  if (phase === 'denied') {
    return (
      <DoorCard title="ENTRADA RECUSADA">
        <p className="text-sm text-muted">Alguém na reunião de {host} recusou o seu pedido.</p>
        <Button onClick={cancelKnock}>PEDIR DE NOVO</Button>
      </DoorCard>
    );
  }
  if (phase === 'waiting') {
    return (
      <DoorCard title={`REUNIÃO DE ${host.toUpperCase()}`}>
        <Loading label="ESPERANDO ALGUÉM DEIXAR VOCÊ ENTRAR" />
        <p className="text-sm text-muted">
          Quem já está na reunião vê o seu pedido. Mantenha esta página aberta.
        </p>
        <Button onClick={cancelKnock}>CANCELAR</Button>
      </DoorCard>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void knock(user ? undefined : name.trim());
  };
  return (
    <DoorCard title={`REUNIÃO DE ${host.toUpperCase()}`}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        {user ? (
          <p className="text-sm text-muted">
            Você vai entrar como <span className="text-fg">{user.displayName}</span>.
          </p>
        ) : (
          <Field label="SEU NOME" hint="É assim que as pessoas na reunião vão ver você.">
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              maxLength={32}
              autoFocus
              required
            />
          </Field>
        )}
        <FormError message={error} />
        <Button variant="primary" type="submit" disabled={busy || (!user && !name.trim())}>
          {busy ? 'PEDINDO' : 'PEDIR PARA ENTRAR'}
        </Button>
      </form>
      {!user && (
        <p className="text-xs text-muted">
          Tem conta?{' '}
          <Link
            to={`/login?next=${encodeURIComponent(window.location.pathname)}`}
            className="text-fg underline hover:text-accent"
          >
            Entre
          </Link>{' '}
          para usar o seu nome.
        </p>
      )}
    </DoorCard>
  );
}

function MeetingRoom() {
  const phase = useMeetingStore((state) => state.phase);
  const meeting = useMeetingStore((state) => state.meeting);
  const preview = useMeetingStore((state) => state.preview);
  const error = useMeetingStore((state) => state.error);
  const voiceStatus = useVoiceStore((state) => state.status);
  const voiceError = useVoiceStore((state) => state.error);
  const [panel, setPanel] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useVoiceShortcuts();
  useEffect(() => {
    if (!confirmEnd) return;
    const timer = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(timer);
  }, [confirmEnd]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const self = meeting?.participants.find((p) => p.id === meeting.selfId);
  const inCall = meeting?.participants.filter((p) => p.inCall).length ?? 0;
  const waiting = meeting?.waiting.length ?? 0;
  const copy = () => {
    void navigator.clipboard?.writeText(window.location.href).then(() => setCopied(true));
  };

  return (
    <main className="flex h-dvh flex-col bg-bg">
      <header className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-surface px-3 py-1.5">
        <h1 className="label-lg truncate text-fg">
          REUNIÃO DE {(meeting?.hostName ?? preview?.hostName ?? '').toUpperCase()}
        </h1>
        <span className="label text-muted" data-testid="meeting-count">
          {inCall} NA CHAMADA
        </span>
        <span className="flex-1" />
        <Button onClick={copy}>{copied ? 'LINK COPIADO' : 'COPIAR LINK'}</Button>
        {self?.host && (
          <Button
            variant="danger"
            onClick={() => (confirmEnd ? void endMeeting() : setConfirmEnd(true))}
          >
            {confirmEnd ? 'CONFIRMAR: ENCERRAR' : 'ENCERRAR PARA TODOS'}
          </Button>
        )}
        <Button
          className="lg:hidden"
          variant={panel ? 'active' : 'default'}
          onClick={() => setPanel(!panel)}
        >
          {waiting > 0 ? `PESSOAS · ${waiting} ESPERANDO` : 'PESSOAS E CHAT'}
        </Button>
      </header>
      <div className="relative flex min-h-0 flex-1">
        <section className="flex min-w-0 flex-1 flex-col">
          {/* The call can also end outside this page (the desktop app's disconnect button): it
              is then the same as having left it, never an endless wait. */}
          {phase === 'left' || voiceStatus === 'idle' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
              <p className="label-lg text-fg">VOCÊ SAIU DA CHAMADA</p>
              <p className="text-sm text-muted">A reunião continua enquanto houver alguém nela.</p>
              <Button variant="primary" onClick={rejoinCall}>
                VOLTAR PARA A CHAMADA
              </Button>
            </div>
          ) : voiceStatus === 'error' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4 text-center">
              <p role="alert" className="label text-danger">
                {voiceError ?? 'NÃO FOI POSSÍVEL ENTRAR NA CHAMADA'}
              </p>
              <Button variant="primary" onClick={rejoinCall}>
                TENTAR DE NOVO
              </Button>
            </div>
          ) : voiceStatus === 'connected' || voiceStatus === 'reconnecting' ? (
            <>
              <div className="min-h-0 flex-1">
                <VoiceStage
                  selfName={self?.name ?? ''}
                  userId={meeting?.selfId}
                  personMenu={personMenu}
                  serverMutedLabel="MUTADO PELO ANFITRIÃO"
                  serverMutedOf={(id) =>
                    meeting?.participants.find((p) => p.id === id)?.mutedByHost ?? false
                  }
                />
              </div>
              <div className="shrink-0 border-t border-line bg-surface p-3">
                <VoiceControls
                  onLeave={leaveCall}
                  noMicNote={self?.mutedByHost ? 'MUTADO PELO ANFITRIÃO' : undefined}
                />
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <Loading label="ENTRANDO NA CHAMADA" />
            </div>
          )}
        </section>
        <aside
          className={cx(
            'w-80 shrink-0 flex-col border-l border-line bg-surface max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-10 max-lg:w-full max-lg:max-w-sm',
            panel ? 'flex' : 'hidden lg:flex',
          )}
        >
          {meeting ? (
            <MeetingPanel meeting={meeting} error={error} />
          ) : (
            <Loading label="CARREGANDO" className="p-3" />
          )}
        </aside>
      </div>
      {voiceStatus !== 'idle' && voiceStatus !== 'error' && (
        <footer className="label flex min-h-8 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-t border-line bg-surface px-3 py-1.5 text-muted max-md:flex-nowrap max-md:overflow-x-auto max-md:whitespace-nowrap">
          <Metric label="PESSOAS" value={meeting?.participants.length ?? 0} />
          <VoiceSystemBar />
        </footer>
      )}
    </main>
  );
}

function MeetingPanel({ meeting, error }: { meeting: MeetingState; error: string | null }) {
  const isHost = meeting.participants.some((p) => p.id === meeting.selfId && p.host);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {meeting.waiting.length > 0 && (
        <section className="shrink-0 border-b border-line p-3" aria-label="Pedindo para entrar">
          <p className="label text-accent">PEDINDO PARA ENTRAR · {meeting.waiting.length}</p>
          <ul className="mt-2 flex flex-col gap-2">
            {meeting.waiting.map((person) => (
              <li key={person.id} className="anim-badge flex flex-col gap-1.5" data-testid="knock">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm text-fg">{person.name}</span>
                  <span className="label shrink-0 text-muted">
                    {person.hasAccount ? 'COM CONTA' : 'CONVIDADO'}
                  </span>
                </span>
                <span className="flex gap-2">
                  <Button variant="primary" onClick={() => void admit(person.id)}>
                    ADMITIR
                  </Button>
                  <Button onClick={() => void deny(person.id)}>RECUSAR</Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FormError message={error} />
      <section className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line p-3">
        <p className="label text-muted">PESSOAS · {meeting.participants.length}</p>
        <ul className="mt-2 flex flex-col gap-1">
          {meeting.participants.map((person) => {
            const isSelf = person.id === meeting.selfId;
            // Someone else's volume, in the call; and, for the host, anyone but the host.
            const hasMenu = !isSelf && (person.inCall || (isHost && !person.host));
            return (
              <li
                key={person.id}
                className="flex items-center justify-between gap-2"
                data-testid="meeting-person"
                {...personMenu(person.id)}
              >
                <span className={cx('truncate text-sm', person.inCall ? 'text-fg' : 'text-muted')}>
                  {person.name}
                  {isSelf && <span className="text-muted"> (você)</span>}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="label text-muted">
                    {[
                      person.host && 'ANFITRIÃO',
                      person.mutedByHost && 'MUTADO',
                      !person.inCall && 'FORA DA CHAMADA',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  {hasMenu && (
                    <Button
                      bare
                      className="h-6 px-1.5"
                      aria-label={`Opções de ${person.name}`}
                      onClick={(event) => {
                        const box = event.currentTarget.getBoundingClientRect();
                        openPersonMenu(person.id, { x: box.left, y: box.bottom + 4 });
                      }}
                    >
                      ···
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
      <MeetingChat meeting={meeting} />
    </div>
  );
}

function MeetingChat({ meeting }: { meeting: MeetingState }) {
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLOListElement>(null);
  const count = meeting.messages.length;

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [count]);

  const send = (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft('');
    void say(content);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Chat da reunião">
      <p className="label px-3 pt-3 text-muted">CHAT · SOME QUANDO A REUNIÃO ACABAR</p>
      <ol ref={list} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {meeting.messages.length === 0 && (
          <li className="text-sm text-muted">Ninguém escreveu nada ainda.</li>
        )}
        {meeting.messages.map((message) => (
          <li key={message.id} className="flex flex-col" data-testid="meeting-message">
            <span className="label text-muted">
              {message.name} ·{' '}
              {new Date(message.at).toLocaleTimeString('pt-BR', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
            <span className="text-sm break-words whitespace-pre-wrap text-fg">
              {message.content}
            </span>
          </li>
        ))}
      </ol>
      <form onSubmit={send} className="flex gap-2 border-t border-line p-3">
        <input
          className="field min-w-0 flex-1"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Escreva para a reunião"
          aria-label="Mensagem para a reunião"
          maxLength={2000}
        />
        <Button type="submit" disabled={!draft.trim()}>
          ENVIAR
        </Button>
      </form>
    </section>
  );
}
