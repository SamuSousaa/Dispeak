import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { attempt } from '../../components/Toast';
import { useIsBlocked } from '../friends/conversations-api';
import { conversationWith } from '../friends/dm';
import { openConversation } from '../friends/open-conversation';

/**
 * Under someone's profile card: talk to them right there, Discord-like. Writing in the box and
 * pressing Enter sends the message and opens the conversation, started if there is none.
 */
export function ProfileActions({
  selfId,
  userId,
  username,
  onDone,
}: {
  selfId: string;
  userId: string;
  username: string;
  /** Closes the card once the conversation is on screen. */
  onDone: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const blocked = useIsBlocked(userId);
  const conversation = conversationWith(selfId, userId);
  const closed = blocked || conversation?.state.blocked;

  const go = (message?: string) => {
    setBusy(true);
    attempt(async () => {
      try {
        await openConversation(userId, message);
        onDone();
      } finally {
        setBusy(false);
      }
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) go(text);
  };

  if (closed) {
    return (
      <p className="label border-t border-line px-3 py-2 text-muted">
        {blocked ? 'VOCÊ BLOQUEOU ESTA PESSOA' : 'NÃO É POSSÍVEL CONVERSAR COM ESTA PESSOA'}
      </p>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2 border-t border-line px-3 py-3">
      <input
        className="field"
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={`Mensagem para @${username}`}
        aria-label={`Mensagem para @${username}`}
        maxLength={2000}
        disabled={busy}
        // The card opens on a click: typing should not need another one.
        autoFocus
      />
      <Button className="self-start" disabled={busy} onClick={() => go()}>
        {conversation ? 'ABRIR CONVERSA' : 'INICIAR CONVERSA'}
      </Button>
    </form>
  );
}
