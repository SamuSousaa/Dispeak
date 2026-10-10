import type { Guild, Message } from '@frequencia/shared';
import { useState } from 'react';
import { cx } from '../../lib/cx';
import { Attachments } from './Attachments';
import { memberName } from '../guilds/permissions';
import { chatApi } from './chat-store';
import { Composer } from './Composer';
import { parseContent, toEditableContent } from './mentions';

const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

function Content({ message, guild }: { message: Message; guild: Guild }) {
  // An image sent on its own has no text line.
  if (!message.content) {
    return message.editedAt ? <p className="label text-muted">(EDITADA)</p> : null;
  }
  return (
    <p className="text-sm leading-5 break-words whitespace-pre-wrap text-fg">
      {parseContent(message.content, guild, message.mentionEveryone).map((part, index) => {
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

interface MessageItemProps {
  message: Message;
  guild: Guild;
  userId: string;
  /** First message of a run by the same author: shows the name and time. */
  showHeader: boolean;
  canModerate: boolean;
  canMentionEveryone: boolean;
}

export function MessageItem({
  message,
  guild,
  userId,
  showHeader,
  canModerate,
  canMentionEveryone,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isMine = message.author.id === userId;
  const mentionsMe = message.mentionEveryone || message.mentions.includes(userId);
  const isMember = guild.members.some((member) => member.user.id === message.author.id);
  const author = isMember ? memberName(guild, message.author.id) : message.author.displayName;
  const actionClass = 'label px-1.5 py-0.5 text-muted transition-colors hover:text-accent';

  return (
    <li
      data-testid="message"
      data-mentions-me={mentionsMe}
      className={cx(
        'anim-fade group relative border-l-2 px-4 py-0.5 transition-colors hover:bg-surface',
        showHeader && 'mt-3',
        mentionsMe ? 'border-fg bg-surface' : 'border-transparent',
      )}
    >
      {showHeader && (
        <div className="flex items-baseline gap-2">
          <span className="label-lg text-fg">{author}</span>
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
        <Content message={message} guild={guild} />
      )}
      <Attachments attachments={message.attachments} />

      {!editing && (isMine || canModerate) && (
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
              <button
                type="button"
                className={actionClass}
                aria-label="Excluir mensagem"
                onClick={() => setConfirming(true)}
              >
                EXCLUIR
              </button>
            </>
          )}
        </div>
      )}
    </li>
  );
}
