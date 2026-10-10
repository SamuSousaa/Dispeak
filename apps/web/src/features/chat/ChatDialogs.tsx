import { POLL_MAX_OPTIONS, type Channel } from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { Dialog, Field, FormError } from '../../components/Dialog';
import { describeError } from '../../lib/http';
import { guildApi } from '../guilds/guild-api';
import { chatApi } from './chat-store';

/** Asks a question with a few answers to choose from, and posts it in the channel. */
export function CreatePollDialog({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filled = options.map((option) => option.trim()).filter(Boolean);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (filled.length < 2) {
      setError('UMA ENQUETE PRECISA DE PELO MENOS DUAS OPÇÕES.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await chatApi.send(channelId, '', [], null, {
        question: question.trim(),
        options: filled,
        multiple,
      });
      onClose();
    } catch (failure) {
      setError(describeError(failure).toUpperCase());
      setBusy(false);
    }
  };

  return (
    <Dialog title="Criar enquete" eyebrow="CHAT" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 p-4">
        <Field label="PERGUNTA">
          <input
            className="field"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={300}
            required
            autoFocus
          />
        </Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="label mb-1.5 text-muted">OPÇÕES</legend>
          {options.map((option, index) => (
            <div key={index} className="flex gap-1.5">
              <input
                className="field"
                value={option}
                aria-label={`Opção ${index + 1}`}
                placeholder={`Opção ${index + 1}`}
                maxLength={100}
                onChange={(event) =>
                  setOptions((current) =>
                    current.map((entry, at) => (at === index ? event.target.value : entry)),
                  )
                }
              />
              {options.length > 2 && (
                <Button
                  bare
                  aria-label={`Remover opção ${index + 1}`}
                  onClick={() => setOptions((current) => current.filter((_, at) => at !== index))}
                >
                  X
                </Button>
              )}
            </div>
          ))}
          {options.length < POLL_MAX_OPTIONS && (
            <Button
              className="self-start"
              onClick={() => setOptions((current) => [...current, ''])}
            >
              ADICIONAR OPÇÃO
            </Button>
          )}
        </fieldset>
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-(--accent)"
            checked={multiple}
            onChange={(event) => setMultiple(event.target.checked)}
          />
          <span className="flex min-w-0 flex-col">
            <span className="label text-fg">PERMITIR VÁRIAS RESPOSTAS</span>
            <span className="text-xs text-muted">Cada pessoa pode marcar mais de uma opção.</span>
          </span>
        </label>
        <FormError message={error} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            PUBLICAR ENQUETE
          </Button>
          <Button onClick={onClose}>CANCELAR</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Opens a side conversation under a text channel and tells the caller which one it is. */
export function CreateThreadDialog({
  channel,
  suggestedName = '',
  onCreated,
  onClose,
}: {
  channel: Channel;
  suggestedName?: string;
  onCreated: (thread: Channel) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(suggestedName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onCreated(await guildApi.createThread(channel.id, name.trim()));
      onClose();
    } catch (failure) {
      setError(describeError(failure).toUpperCase());
      setBusy(false);
    }
  };

  return (
    <Dialog title="Criar tópico" eyebrow={`EM ${channel.name}`} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted">
          Um tópico é uma conversa à parte dentro deste canal, para um assunto não tomar conta do
          chat. Quem vê o canal vê o tópico.
        </p>
        <Field label="NOME DO TÓPICO">
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            required
            autoFocus
          />
        </Field>
        <FormError message={error} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
            CRIAR TÓPICO
          </Button>
          <Button onClick={onClose}>CANCELAR</Button>
        </div>
      </form>
    </Dialog>
  );
}
