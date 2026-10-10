import type { Guild, Message, MessageReference } from '@frequencia/shared';
import { useState, type MouseEvent } from 'react';
import { Avatar } from '../../components/Avatar';
import { contextMenu } from '../../components/ContextMenu';
import { cx } from '../../lib/cx';
import { memberColor, memberName } from '../guilds/permissions';
import { Attachments } from './Attachments';
import { chatApi } from './chat-store';
import { Composer } from './Composer';
import { Embeds, isImageLink } from './Embeds';
import { openReactionPicker, QUICK_REACTIONS } from './EmojiGrid';
import { parseContent, toEditableContent, type ContentPart } from './mentions';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

const messageElementId = (id: string) => `message-${id}`;

/** Scrolls to a message that is loaded and lights it up for a moment. */
function jumpToMessage(id: string): void {
  const element = document.getElementById(messageElementId(id));
  if (!element) return;
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  element.dataset.flash = 'true';
  window.setTimeout(() => delete element.dataset.flash, 1200);
}

function Content({ message, parts }: { message: Message; parts: ContentPart[] }) {
  // An image sent on its own has no text line; neither has a lone link shown as a picture.
  const loneImage = parts.length === 1 && parts[0]?.type === 'link' && isImageLink(parts[0].href);
  if (!message.content || loneImage) {
    return message.editedAt ? <p className="label text-muted">(EDITADA)</p> : null;
  }
  return (
    <p className="text-sm leading-5 break-words whitespace-pre-wrap text-fg">
      {parts.map((part, index) => {
        switch (part.type) {
          case 'text':
            return <span key={index}>{part.text}</span>;
          case 'mention':
            return (
              <span key={index} className="bg-surface-2 px-1 font-medium text-fg" data-mention>
                @{part.name}
              </span>
            );
          case 'everyone':
            return (
              <span key={index} className="bg-surface-2 px-1 font-medium text-fg" data-mention>
                @todos
              </span>
            );
          case 'link':
            return (
              <a
                key={index}
                href={part.href}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-accent"
              >
                {part.href}
              </a>
            );
        }
      })}
      {message.editedAt && <span className="label ml-2 text-muted">(EDITADA)</span>}
    </p>
  );
}

/** The message being answered, one line above the answer. */
function ReplyQuote({ reference, guild }: { reference: MessageReference; guild: Guild }) {
  const isMember = guild.members.some((member) => member.user.id === reference.author.id);
  const author = isMember ? memberName(guild, reference.author.id) : reference.author.displayName;
  const excerpt =
    parseContent(reference.content, guild, true)
      .map((part) => {
        if (part.type === 'text') return part.text;
        if (part.type === 'mention') return `@${part.name}`;
        return part.type === 'everyone' ? '@todos' : part.href;
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim() || (reference.attachments > 0 ? 'imagem' : '');
  return (
    <button
      type="button"
      data-testid="reply-quote"
      title="Ir para a mensagem original"
      onClick={() => jumpToMessage(reference.id)}
      className="flex max-w-full items-baseline gap-1.5 border-l-2 border-line-strong pl-2 text-left text-muted transition-colors hover:border-accent hover:text-fg"
    >
      <span className="label shrink-0">↳ {author}</span>
      <span className="truncate text-xs">{excerpt}</span>
    </button>
  );
}

interface MessageItemProps {
  message: Message;
  guild: Guild;
  userId: string;
  /** First message of a run by the same author: shows the name and time. */
  showHeader: boolean;
  canModerate: boolean;
  canMentionEveryone: boolean;
  /** Starts an answer to this message; absent where the user cannot write. */
  onReply?: (message: Message) => void;
}

export function MessageItem({
  message,
  guild,
  userId,
  showHeader,
  canModerate,
  canMentionEveryone,
  onReply,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isMine = message.author.id === userId;
  const canDelete = isMine || canModerate;
  const mentionsMe = message.mentionEveryone || message.mentions.includes(userId);
  const member = guild.members.find((entry) => entry.user.id === message.author.id);
  const author = member ? memberName(guild, message.author.id) : message.author.displayName;
  // Members show the picture they have now; people who left keep the one the message came with.
  const picture = member ? member.user.avatar : message.author.avatar;
  const parts = parseContent(message.content, guild, message.mentionEveryone);
  const links = parts.flatMap((part) => (part.type === 'link' ? [part.href] : []));
  const actionClass = 'label px-1.5 py-0.5 text-muted transition-colors hover:text-accent';

  const toggleReaction = (emoji: string) => {
    const mine = message.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.userIds.includes(userId),
    );
    // The gateway brings the new state; a refusal just leaves things as they were.
    void (mine ? chatApi.unreact(message.id, emoji) : chatApi.react(message.id, emoji)).catch(
      () => undefined,
    );
  };
  const pickReaction = (event: MouseEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    openReactionPicker({ x: box.left, y: box.bottom + 4 }, (emoji) => {
      // Picking one that is already mine keeps it, instead of taking it back.
      void chatApi.react(message.id, emoji).catch(() => undefined);
    });
  };

  const menu = contextMenu(`MENSAGEM DE ${author}`, () => [
    {
      type: 'custom',
      key: 'quick-reactions',
      render: (close) => (
        <div className="flex justify-between">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`Reagir com ${emoji}`}
              className="flex h-8 w-8 items-center justify-center text-lg transition-colors hover:bg-surface"
              onClick={() => {
                close();
                toggleReaction(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      ),
    },
    { type: 'separator' },
    onReply && { label: 'Responder', onSelect: () => onReply(message) },
    Boolean(message.content) && {
      label: 'Copiar texto',
      onSelect: () =>
        void navigator.clipboard?.writeText(toEditableContent(message.content, guild)),
    },
    isMine && { label: 'Editar', onSelect: () => setEditing(true) },
    { type: 'separator' },
    canDelete && { label: 'Excluir', danger: true, onSelect: () => setConfirming(true) },
  ]);

  return (
    <li
      id={messageElementId(message.id)}
      data-testid="message"
      data-mentions-me={mentionsMe}
      className={cx(
        'anim-fade group relative border-l-2 py-0.5 pr-4 pl-[58px] transition-colors hover:bg-surface data-flash:bg-surface-2',
        (showHeader || message.replyTo) && 'mt-3',
        mentionsMe ? 'border-fg bg-surface' : 'border-transparent',
      )}
      {...(editing ? {} : menu)}
    >
      {message.replyTo && <ReplyQuote reference={message.replyTo} guild={guild} />}
      {(showHeader || message.replyTo) && (
        <div className="relative flex items-baseline gap-2">
          <Avatar name={author} picture={picture} size={32} className="absolute top-0.5 -left-11" />
          <span
            className="label-lg text-fg"
            style={member ? { color: memberColor(guild, message.author.id) } : undefined}
          >
            {author}
          </span>
          <time className="label text-muted" dateTime={message.createdAt}>
            {timeFormat.format(new Date(message.createdAt))}
          </time>
        </div>
      )}

      {editing ? (
        <div className="py-1">
          <Composer
            guild={guild}
            placeholder="Editar mensagem"
            initialText={toEditableContent(message.content, guild)}
            canMentionEveryone={canMentionEveryone}
            autoFocus
            allowEmpty={message.attachments.length > 0}
            onCancel={() => setEditing(false)}
            onSubmit={async (content) => {
              if (content !== message.content) await chatApi.edit(message.id, content);
              setEditing(false);
            }}
          />
          <p className="label mt-1 text-muted">ENTER PARA SALVAR · ESC PARA CANCELAR</p>
        </div>
      ) : (
        <Content message={message} parts={parts} />
      )}
      <Attachments attachments={message.attachments} />
      {!editing && <Embeds links={links} />}

      {message.reactions.length > 0 && (
        <ul aria-label="Reações" className="flex flex-wrap gap-1 py-1">
          {message.reactions.map((reaction) => {
            const mine = reaction.userIds.includes(userId);
            const names = reaction.userIds.map((id) => memberName(guild, id)).join(', ');
            return (
              <li key={reaction.emoji}>
                <button
                  type="button"
                  data-testid="reaction"
                  aria-pressed={mine}
                  aria-label={`${reaction.emoji}, ${reaction.userIds.length}: ${names}`}
                  title={names}
                  onClick={() => toggleReaction(reaction.emoji)}
                  className={cx(
                    'pressable flex h-6 items-center gap-1.5 border px-1.5',
                    mine
                      ? 'border-accent bg-surface-2 text-accent'
                      : 'border-line-strong text-muted hover:border-accent hover:text-fg',
                  )}
                >
                  <span className="text-sm leading-none">{reaction.emoji}</span>
                  <span className="label">{reaction.userIds.length}</span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              aria-label="Adicionar reação"
              title="Adicionar reação"
              onClick={pickReaction}
              className="pressable label flex h-6 items-center border border-line-strong px-1.5 text-muted hover:border-accent hover:text-accent"
            >
              +
            </button>
          </li>
        </ul>
      )}

      {!editing && (
        <div
          className={cx(
            'absolute -top-3 right-3 flex border border-line-strong bg-bg',
            confirming
              ? 'opacity-100'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
        >
          {confirming ? (
            <>
              <button
                type="button"
                className={cx(actionClass, 'text-danger')}
                onClick={() => void chatApi.delete(message.id).catch(() => setConfirming(false))}
              >
                CONFIRMAR
              </button>
              <button type="button" className={actionClass} onClick={() => setConfirming(false)}>
                CANCELAR
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={actionClass}
                aria-label="Reagir à mensagem"
                onClick={pickReaction}
              >
                REAGIR
              </button>
              {onReply && (
                <button
                  type="button"
                  className={actionClass}
                  aria-label="Responder mensagem"
                  onClick={() => onReply(message)}
                >
                  RESPONDER
                </button>
              )}
              {isMine && (
                <button
                  type="button"
                  className={actionClass}
                  aria-label="Editar mensagem"
                  onClick={() => setEditing(true)}
                >
                  EDITAR
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className={actionClass}
                  aria-label="Excluir mensagem"
                  onClick={() => setConfirming(true)}
                >
                  EXCLUIR
                </button>
              )}
            </>
          )}
        </div>
      )}
    </li>
  );
}
