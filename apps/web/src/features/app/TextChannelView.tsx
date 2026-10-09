import {
  hasPermission,
  Permissions,
  type Channel,
  type Guild,
  type Message,
} from '@frequencia/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { chatApi, flattenMessages, messagesKey, useTypingStore } from '../chat/chat-store';
import { Composer } from '../chat/Composer';
import { MessageItem } from '../chat/MessageItem';
import { channelPermissions, memberName } from '../guilds/permissions';

const dayFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
/** Consecutive messages of one author within this window share a header. */
const GROUP_WINDOW_MS = 5 * 60 * 1000;
const TYPING_THROTTLE_MS = 4000;
const STICK_TO_BOTTOM_PX = 120;

const dayOf = (message: Message) => new Date(message.createdAt).toDateString();

function TypingIndicator({
  guild,
  channelId,
  userId,
}: {
  guild: Guild;
  channelId: string;
  userId: string;
}) {
  const typing = useTypingStore((state) => state.typing[channelId]);
  const [now, setNow] = useState(() => Date.now());

  // Notices expire on their own; tick only while there is something to expire.
  const pending = Object.keys(typing ?? {}).length > 0;
  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [pending]);

  const names = Object.entries(typing ?? {})
    .filter(([id, expiresAt]) => id !== userId && expiresAt > now)
    .map(([id]) => memberName(guild, id));

  let text = '';
  if (names.length === 1) text = `${names[0]} ESTÁ DIGITANDO`;
  else if (names.length === 2) text = `${names[0]} E ${names[1]} ESTÃO DIGITANDO`;
  else if (names.length > 2) text = 'VÁRIAS PESSOAS ESTÃO DIGITANDO';

  return (
    <p className="label h-4 text-muted" aria-live="polite" data-testid="typing">
      {text}
    </p>
  );
}

/** Main area for a text channel: history, live messages and the composer. */
export function TextChannelView({
  guild,
  channel,
  userId,
}: {
  guild: Guild;
  channel: Channel;
  userId: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);
  const lastTyping = useRef(0);

  const permissions = channelPermissions(guild, channel, userId);
  const canSend = hasPermission(permissions, Permissions.SendMessages);
  const canModerate = hasPermission(permissions, Permissions.ManageMessages);
  const canMentionEveryone = hasPermission(permissions, Permissions.MentionEveryone);

  const history = useInfiniteQuery({
    queryKey: messagesKey(channel.id),
    queryFn: ({ pageParam }) => chatApi.list(channel.id, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (oldest) => oldest.nextCursor ?? undefined,
    staleTime: Infinity, // kept current by gateway events
  });
  const messages = flattenMessages(history.data);
  const newestId = messages.at(-1)?.id;
  const oldestId = messages[0]?.id;

  // New message at the bottom: follow it, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [newestId]);

  // Older page prepended: keep the message the user was looking at in place.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && heightBeforeOlder.current !== null) {
      element.scrollTop += element.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
    }
  }, [oldestId]);

  const loadOlder = () => {
    if (!history.hasNextPage || history.isFetchingNextPage) return;
    heightBeforeOlder.current = scrollRef.current?.scrollHeight ?? null;
    void history.fetchNextPage();
  };

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const fromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottom.current = fromBottom < STICK_TO_BOTTOM_PX;
    if (element.scrollTop < 80) loadOlder();
  };

  const notifyTyping = () => {
    const now = Date.now();
    if (now - lastTyping.current < TYPING_THROTTLE_MS) return;
    lastTyping.current = now;
    void chatApi.typing(channel.id).catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="grid-bg min-h-0 flex-1 overflow-y-auto"
        tabIndex={0}
        role="log"
        aria-label={`Mensagens de ${channel.name}`}
      >
        <div className="flex min-h-full flex-col justify-end py-3">
          {history.isPending && <p className="label px-4 text-muted">CARREGANDO MENSAGENS</p>}
          {history.isError && (
            <p role="alert" className="label px-4 text-danger">
              NÃO FOI POSSÍVEL CARREGAR AS MENSAGENS
            </p>
          )}
          {history.hasNextPage && (
            <div className="px-4 pb-2">
              <Button onClick={loadOlder} disabled={history.isFetchingNextPage}>
                {history.isFetchingNextPage ? 'CARREGANDO' : 'CARREGAR ANTERIORES'}
              </Button>
            </div>
          )}
          {history.isSuccess && !history.hasNextPage && (
            <p className="label px-4 pb-1 text-muted">
              INÍCIO DE {channel.name}
              {channel.topic ? ` — ${channel.topic}` : ''}
            </p>
          )}
          <ol>
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const newDay = !previous || dayOf(previous) !== dayOf(message);
              const showHeader =
                newDay ||
                previous.author.id !== message.author.id ||
                Date.parse(message.createdAt) - Date.parse(previous.createdAt) > GROUP_WINDOW_MS;
              return (
                <Fragment key={message.id}>
                  {newDay && (
                    <li className="label mt-3 flex items-center gap-3 px-4 text-muted" aria-hidden>
                      <span className="h-px flex-1 bg-line" />
                      {dayFormat.format(new Date(message.createdAt)).replace('.', '')}
                      <span className="h-px flex-1 bg-line" />
                    </li>
                  )}
                  <MessageItem
                    message={message}
                    guild={guild}
                    userId={userId}
                    showHeader={showHeader}
                    canModerate={canModerate}
                    canMentionEveryone={canMentionEveryone}
                  />
                </Fragment>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="shrink-0 border-t border-line bg-surface px-3 pt-2 pb-1">
        {canSend ? (
          <Composer
            key={channel.id}
            guild={guild}
            placeholder={`Mensagem em ${channel.name}`}
            canMentionEveryone={canMentionEveryone}
            onTyping={notifyTyping}
            onSubmit={async (content) => {
              stickToBottom.current = true;
              await chatApi.send(channel.id, content);
            }}
          />
        ) : (
          <p className="label py-2 text-muted">VOCÊ NÃO PODE ENVIAR MENSAGENS NESTE CANAL</p>
        )}
        <TypingIndicator guild={guild} channelId={channel.id} userId={userId} />
      </div>
    </div>
  );
}
