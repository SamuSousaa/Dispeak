import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { attempt } from '../../components/Toast';
import { conversationsApi } from './conversations-api';
import type { Conversation } from './dm';

/**
 * A line above a private conversation that is not a plain one: a request to answer, a request
 * still unanswered by the other person, or a block. Nothing for an ordinary conversation.
 */
export function ConversationBar({ conversation }: { conversation: Conversation }) {
  const { guild, friend, state } = conversation;
  const name = friend.user.displayName;

  if (state.blocked === 'you') {
    return (
      <Bar testId="conversation-blocked">
        <span className="label text-fg">VOCÊ BLOQUEOU {name.toUpperCase()}</span>
        <span className="text-xs text-muted">Nenhum dos dois envia mensagens nem liga.</span>
        <Button onClick={() => attempt(() => conversationsApi.unblock(friend.user.id))}>
          DESBLOQUEAR
        </Button>
      </Bar>
    );
  }
  if (state.blocked === 'other') {
    return (
      <Bar testId="conversation-blocked">
        <span className="label text-muted">NÃO É POSSÍVEL ENVIAR MENSAGENS NESTA CONVERSA</span>
      </Bar>
    );
  }
  if (state.request === 'incoming') {
    return (
      <Bar testId="message-request">
        <span className="label text-fg">PEDIDO DE MENSAGEM</span>
        <span className="text-xs text-muted">
          {name} não é seu amigo. Responder ou aceitar abre a conversa; recusar a esconde, sem
          avisar.
        </span>
        <span className="flex gap-2">
          <Button
            variant="primary"
            onClick={() => attempt(() => conversationsApi.accept(guild.id))}
          >
            ACEITAR
          </Button>
          <Button onClick={() => attempt(() => conversationsApi.decline(guild.id))}>RECUSAR</Button>
          <Button
            variant="danger"
            onClick={() => attempt(() => conversationsApi.block(friend.user.id))}
          >
            BLOQUEAR
          </Button>
        </span>
      </Bar>
    );
  }
  if (state.request === 'outgoing') {
    return (
      <Bar testId="message-request-sent">
        <span className="label text-muted">PEDIDO DE MENSAGEM ENVIADO</span>
        <span className="text-xs text-muted">
          {name} não é seu amigo e ainda não aceitou. Chamadas ficam liberadas quando aceitar.
        </span>
      </Bar>
    );
  }
  return null;
}

function Bar({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="anim-rise flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-surface-2 px-4 py-2.5"
    >
      {children}
    </div>
  );
}
