import {
  ATTACHMENT_CONTENT_TYPES,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  EVERYONE_MENTION,
  MESSAGE_MAX_LENGTH,
  type Guild,
} from '@frequencia/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton } from '../../components/IconButton';
import { cx } from '../../lib/cx';
import { describeError } from '../../lib/http';
import { memberName } from '../guilds/permissions';
import { EMOJI_GROUPS } from './emoji';
import { mentionQueryAt, toWireContent } from './mentions';

interface ComposerProps {
  guild: Guild;
  /** Shown as the placeholder, e.g. the channel name. */
  placeholder: string;
  initialText?: string;
  canMentionEveryone: boolean;
  /** Resolves when the message was accepted; a rejection keeps everything for a retry. */
  onSubmit: (content: string, files: File[]) => Promise<void>;
  onCancel?: () => void;
  onTyping?: () => void;
  autoFocus?: boolean;
  /** Offers attaching images (button, paste and drop). */
  attachments?: boolean;
  /** Accepts an empty text: editing a message that keeps its images. */
  allowEmpty?: boolean;
}

interface Suggestion {
  key: string;
  label: string;
  hint: string;
}

interface PendingFile {
  key: string;
  file: File;
  /** Local preview. */
  url: string;
}

const MAX_SUGGESTIONS = 6;
const ACCEPTED_TYPES: readonly string[] = ATTACHMENT_CONTENT_TYPES;
const MAX_MEGABYTES = ATTACHMENT_MAX_BYTES / (1024 * 1024);

function EmojiPicker({
  onPick,
  onClose,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Emojis"
      className="anim-pop absolute right-0 bottom-full z-10 mb-1 max-h-72 w-80 max-w-full overflow-y-auto border border-line-strong bg-surface-2"
    >
      {EMOJI_GROUPS.map((group) => (
        <section key={group.label}>
          <h3 className="label sticky top-0 border-b border-line bg-surface-2 px-2 py-1 text-muted">
            {group.label}
          </h3>
          <div className="grid grid-cols-8 p-1">
            {group.emojis.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                // Keep focus (and the caret) in the textarea.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(emoji)}
                className="flex aspect-square items-center justify-center text-xl transition-colors hover:bg-surface"
              >
                {emoji}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * Message input: Enter sends, Shift+Enter breaks the line, `@` opens member suggestions.
 * Images can be attached with the button, pasted from the clipboard or dropped on the field.
 */
export function Composer({
  guild,
  placeholder,
  initialText = '',
  canMentionEveryone,
  onSubmit,
  onCancel,
  onTyping,
  autoFocus = false,
  attachments = false,
  allowEmpty = false,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(initialText.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  // Grow with the content, up to a few lines.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const element = ref.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  // Previews are object URLs: release whatever is still pending when the composer goes away.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  });
  useEffect(
    () => () => {
      for (const entry of pendingRef.current) URL.revokeObjectURL(entry.url);
    },
    [],
  );

  const query = dismissed ? null : mentionQueryAt(text, caret);
  const suggestions: Suggestion[] = [];
  if (query) {
    const needle = query.query.toLocaleLowerCase('pt-BR');
    if (canMentionEveryone && EVERYONE_MENTION.slice(1).startsWith(needle)) {
      suggestions.push({ key: 'everyone', label: EVERYONE_MENTION, hint: 'todos os membros' });
    }
    for (const member of guild.members) {
      const name = memberName(guild, member.user.id);
      if (
        name.toLocaleLowerCase('pt-BR').includes(needle) ||
        member.user.username.includes(needle)
      ) {
        suggestions.push({
          key: member.user.id,
          label: `@${name}`,
          hint: `@${member.user.username}`,
        });
      }
    }
    suggestions.splice(MAX_SUGGESTIONS);
  }
  const active = Math.min(selected, Math.max(0, suggestions.length - 1));

  /** Replaces `text[start, end)` and leaves the caret after the inserted piece. */
  const insert = (piece: string, start: number, end: number) => {
    const next = `${text.slice(0, start)}${piece}${text.slice(end)}`.slice(0, MESSAGE_MAX_LENGTH);
    const position = Math.min(start + piece.length, next.length);
    setText(next);
    setCaret(position);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  };

  const pick = (suggestion: Suggestion) => {
    if (query) insert(`${suggestion.label} `, query.start, caret);
  };

  const addFiles = (files: File[]) => {
    if (!attachments || files.length === 0) return;
    const accepted: PendingFile[] = [];
    let problem: string | null = null;
    for (const file of files) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        problem = 'SÓ IMAGENS PNG, JPEG, GIF OU WEBP.';
      } else if (file.size > ATTACHMENT_MAX_BYTES) {
        problem = `CADA IMAGEM PODE TER ATÉ ${MAX_MEGABYTES} MB.`;
      } else if (pending.length + accepted.length >= ATTACHMENT_MAX_PER_MESSAGE) {
        problem = `ATÉ ${ATTACHMENT_MAX_PER_MESSAGE} IMAGENS POR MENSAGEM.`;
      } else {
        accepted.push({ key: crypto.randomUUID(), file, url: URL.createObjectURL(file) });
      }
    }
    setError(problem);
    if (accepted.length > 0) {
      setPending((current) => [...current, ...accepted]);
      onTyping?.();
    }
    ref.current?.focus();
  };

  const removeFile = (key: string) => {
    setPending((current) => {
      const gone = current.find((entry) => entry.key === key);
      if (gone) URL.revokeObjectURL(gone.url);
      return current.filter((entry) => entry.key !== key);
    });
  };

  const submit = async () => {
    const content = toWireContent(text, guild).trim();
    if (busy || (!content && pending.length === 0 && !allowEmpty)) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(
        content,
        pending.map((entry) => entry.file),
      );
      for (const entry of pending) URL.revokeObjectURL(entry.url);
      setPending([]);
      setText('');
      setCaret(0);
    } catch (failure) {
      setError(
        describeError(failure, 'NÃO FOI POSSÍVEL ENVIAR. ENTER PARA TENTAR DE NOVO.').toUpperCase(),
      );
    } finally {
      setBusy(false);
      ref.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setSelected((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const suggestion = suggestions[active];
        if (suggestion) pick(suggestion);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape' && onCancel) {
      event.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="relative"
      onDragOver={(event) => {
        if (!attachments || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!attachments) return;
        event.preventDefault();
        setDragging(false);
        addFiles([...event.dataTransfer.files]);
      }}
    >
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mencionar"
          className="anim-pop absolute bottom-full left-0 z-10 mb-1 w-72 max-w-full border border-line-strong bg-surface-2"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.key} role="option" aria-selected={index === active}>
              <button
                type="button"
                // Keep focus in the textarea while picking with the mouse.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(suggestion)}
                className={cx(
                  'flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left transition-colors',
                  index === active ? 'bg-surface text-accent' : 'text-fg hover:bg-surface',
                )}
              >
                <span className="label-lg truncate">{suggestion.label}</span>
                <span className="label shrink-0 text-muted normal-case">{suggestion.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {emojiOpen && (
        <EmojiPicker
          onPick={(emoji) => {
            const position = ref.current?.selectionStart ?? caret;
            insert(emoji, position, ref.current?.selectionEnd ?? position);
          }}
          onClose={() => setEmojiOpen(false)}
        />
      )}

      {pending.length > 0 && (
        <ul aria-label="Imagens a enviar" className="mb-2 flex flex-wrap gap-2">
          {pending.map((entry) => (
            <li
              key={entry.key}
              className="anim-rise relative h-20 w-20 border border-line-strong bg-bg"
            >
              <img src={entry.url} alt={entry.file.name} className="h-full w-full object-cover" />
              <button
                type="button"
                aria-label={`Remover ${entry.file.name}`}
                disabled={busy}
                onClick={() => removeFile(entry.key)}
                className="label absolute top-0 right-0 border-b border-l border-line-strong bg-bg px-1.5 text-muted transition-colors hover:text-danger"
              >
                X
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-1.5">
        {attachments && (
          <>
            <input
              ref={fileInput}
              type="file"
              accept={ATTACHMENT_CONTENT_TYPES.join(',')}
              multiple
              hidden
              data-testid="attachment-input"
              onChange={(event) => {
                addFiles([...(event.target.files ?? [])]);
                // Lets the same file be picked again after being removed.
                event.target.value = '';
              }}
            />
            <IconButton
              icon="image"
              label="Anexar imagem"
              title="Anexar imagem ou GIF (também dá para colar ou arrastar)"
              className="h-9 w-9"
              disabled={busy || pending.length >= ATTACHMENT_MAX_PER_MESSAGE}
              onClick={() => fileInput.current?.click()}
            />
          </>
        )}
        <textarea
          ref={ref}
          className={cx(
            'field block min-w-0 flex-1 font-sans text-sm leading-5',
            dragging && 'border-accent',
          )}
          style={{ fontFamily: 'var(--font-body)' }}
          rows={1}
          value={text}
          maxLength={MESSAGE_MAX_LENGTH}
          placeholder={dragging ? 'Solte a imagem aqui' : placeholder}
          aria-label={placeholder}
          aria-invalid={Boolean(error)}
          aria-busy={busy}
          onChange={(event) => {
            setText(event.target.value);
            setCaret(event.target.selectionStart);
            setSelected(0);
            setDismissed(false);
            if (event.target.value.trim()) onTyping?.();
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (!attachments || files.length === 0) return;
            // A copied image: attach it instead of pasting its name.
            event.preventDefault();
            addFiles(files);
          }}
        />
        <IconButton
          icon="smile"
          label="Emojis"
          className="h-9 w-9"
          tone={emojiOpen ? 'active' : 'default'}
          aria-expanded={emojiOpen}
          // The picker closes itself on an outside press; do not let that press reopen it.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setEmojiOpen((value) => !value)}
        />
      </div>
      {busy && pending.length > 0 && (
        <p role="status" className="label mt-1 text-muted">
          ENVIANDO {pending.length === 1 ? 'IMAGEM' : `${pending.length} IMAGENS`}…
        </p>
      )}
      {error && (
        <p role="alert" className="label mt-1 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
