import type { FriendRequest } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { openContextMenu } from '../../components/ContextMenu';
import { FormError } from '../../components/Dialog';
import { attempt } from '../../components/Toast';
import { ApiError, describeError } from '../../lib/http';
import { PRESENCE_LABELS, StatusMark } from '../profile/ProfileCard';
import { conversationsApi } from './conversations-api';
import { useFriends, useMessageRequests, type Conversation } from './dm';
import { FRIEND_REQUESTS_KEY, friendsApi } from './friends-api';

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
    <section className="border border-line bg-surface">
      <h2 className="label border-b border-line px-4 py-2 text-muted">
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

function RequestRow({ request }: { request: FriendRequest }) {
  const incoming = request.direction === 'incoming';
  return (
    <li
      data-testid="friend-request"
      className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
    >
      <Avatar name={request.user.displayName} picture={request.user.avatar} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="label-lg truncate text-fg">{request.user.displayName}</span>
        <span className="label truncate text-muted normal-case">
          @{request.user.username} · {incoming ? 'quer ser seu amigo' : 'aguardando resposta'}
        </span>
      </span>
      {incoming && (
        <Button variant="primary" onClick={() => attempt(() => friendsApi.accept(request.id))}>
          ACEITAR
        </Button>
      )}
      <Button onClick={() => attempt(() => friendsApi.dismiss(request.id))}>
        {incoming ? 'RECUSAR' : 'CANCELAR'}
      </Button>
    </li>
  );
}

/** A conversation started by someone who is not a friend, waiting for an answer. */
function MessageRequestRow({ conversation }: { conversation: Conversation }) {
  const navigate = useNavigate();
  const { guild, friend } = conversation;
  return (
    <li
      data-testid="message-request-row"
      className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
    >
      <Avatar name={friend.user.displayName} picture={friend.user.avatar} size={32} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="label-lg truncate text-fg">{friend.user.displayName}</span>
        <span className="label truncate text-muted normal-case">
          @{friend.user.username} · quer conversar com você
        </span>
      </span>
      <Button onClick={() => navigate(`/app/${guild.id}`)}>LER</Button>
      <Button variant="primary" onClick={() => attempt(() => conversationsApi.accept(guild.id))}>
        ACEITAR
      </Button>
      <Button onClick={() => attempt(() => conversationsApi.decline(guild.id))}>RECUSAR</Button>
    </li>
  );
}

/**
 * Home screen: add a friend by username, answer friend and message requests, and the list of
 * friends.
 */
export function FriendsView({ userId }: { userId: string }) {
  const navigate = useNavigate();
  const conversations = useFriends(userId);
  const messageRequests = useMessageRequests(userId);
  const { data: requests = [] } = useQuery({
    queryKey: FRIEND_REQUESTS_KEY,
    queryFn: friendsApi.requests,
  });
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const name = username.trim().replace(/^@/, '').toLowerCase();
    if (!name) return;
    setError(null);
    setSent(null);
    setBusy(true);
    try {
      const result = await friendsApi.ask(name);
      setUsername('');
      // The other person had already asked: the conversation is open.
      if (result.guild) navigate(`/app/${result.guild.id}`);
      else setSent(`Pedido enviado para @${name}.`);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 404
          ? `Ninguém usa o nome @${name}. Confira com a pessoa: é o nome de usuário, não o apelido.`
          : failure instanceof ApiError && failure.status === 409
            ? 'Vocês já são amigos, ou o pedido já foi enviado.'
            : describeError(failure),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid-bg h-full overflow-y-auto p-4">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <Section number="01" title="ADICIONAR AMIGO">
          <form onSubmit={submit} className="flex flex-col gap-3 p-4">
            <label className="flex flex-col gap-1.5">
              <span className="label text-muted">NOME DE USUÁRIO</span>
              <span className="flex flex-wrap gap-2">
                <input
                  className="field min-w-0 flex-1"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="ex.: mayhem.devil"
                  aria-label="Nome de usuário do amigo"
                  maxLength={25}
                  autoComplete="off"
                />
                <Button type="submit" variant="primary" disabled={busy || !username.trim()}>
                  {busy ? 'AGUARDE' : 'ENVIAR PEDIDO'}
                </Button>
              </span>
              <span className="text-xs text-muted">
                É o nome com @ que aparece no perfil da pessoa. Quando ela aceitar, a conversa de
                vocês aparece na lista ao lado.
              </span>
            </label>
            <FormError message={error} />
            {sent && (
              <p role="status" className="label text-accent">
                {sent}
              </p>
            )}
          </form>
        </Section>

        {messageRequests.length > 0 && (
          <Section number="02" title={`PEDIDOS DE MENSAGEM — ${messageRequests.length}`}>
            <ul>
              {messageRequests.map((entry) => (
                <MessageRequestRow key={entry.guild.id} conversation={entry} />
              ))}
            </ul>
          </Section>
        )}

        {requests.length > 0 && (
          <Section
            number={messageRequests.length > 0 ? '03' : '02'}
            title={`PEDIDOS DE AMIZADE — ${requests.length}`}
          >
            <ul>
              {requests.map((request) => (
                <RequestRow key={request.id} request={request} />
              ))}
            </ul>
          </Section>
        )}

        <Section
          number={String(
            2 + (requests.length > 0 ? 1 : 0) + (messageRequests.length > 0 ? 1 : 0),
          ).padStart(2, '0')}
          title={`AMIGOS — ${conversations.length}`}
        >
          {conversations.length === 0 ? (
            <p className="p-4 text-sm text-muted">
              Ninguém por aqui ainda. Envie um pedido acima para começar.
            </p>
          ) : (
            <ul>
              {conversations.map(({ guild, friend, online }) => (
                <li
                  key={guild.id}
                  data-testid="friend"
                  className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2 last:border-b-0"
                >
                  <span className="relative shrink-0">
                    <Avatar name={friend.user.displayName} picture={friend.user.avatar} size={32} />
                    <StatusMark
                      presence={online ? friend.user.status : 'offline'}
                      className="absolute -right-0.5 -bottom-0.5"
                    />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="label-lg truncate text-fg">{friend.user.displayName}</span>
                    <span className="label truncate text-muted normal-case">
                      @{friend.user.username} ·{' '}
                      {PRESENCE_LABELS[online ? friend.user.status : 'offline'].toLowerCase()}
                    </span>
                  </span>
                  <Button onClick={() => navigate(`/app/${guild.id}`)}>CONVERSAR</Button>
                  <Button
                    variant="danger"
                    onClick={(event) =>
                      openContextMenu(
                        { x: event.clientX, y: event.clientY },
                        `DESFAZER AMIZADE COM ${friend.user.displayName}?`,
                        [
                          {
                            label: 'Sim, desfazer (a conversa fica)',
                            danger: true,
                            onSelect: () => attempt(() => friendsApi.remove(friend.user.id)),
                          },
                          { label: 'Cancelar', onSelect: () => undefined },
                        ],
                      )
                    }
                  >
                    REMOVER
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  );
}
