import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_MESSAGE,
  EVERYONE_MENTION,
  MESSAGE_MAX_LENGTH,
  type Guild,
} from '@frequencia/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { openContextMenu } from '../../components/ContextMenu';
import { IconButton } from '../../components/IconButton';
import { cx } from '../../lib/cx';
import { describeError } from '../../lib/http';
import { memberName } from '../guilds/permissions';
import { formatBytes } from './Attachments';
import { ExpressionPicker, type ExpressionTab } from './ExpressionPicker';
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
  /** Offers attaching files (the + button, paste and drop). */
  attachments?: boolean;
  /** Adds "create a poll" to the + menu. */
  onCreatePoll?: () => void;
  /** Adds "create a thread" to the + menu. */
  onCreateThread?: () => void;
  /** Accepts an empty text: editing a message that keeps its images. */
  allowEmpty?: boolean;
  /** Offers the GIF search. */
  gifs?: boolean;
  /** Focuses the field whenever this value changes (e.g. the message being answered). */
  focusKey?: unknown;
}

interface Suggestion {
  key: string;
  label: string;
  hint: string;
}

interface PendingFile {
  key: string;
  file: File;
  /** Local preview, for pictures. */
  url: string | null;
}

const MAX_SUGGESTIONS = 6;
const MAX_MEGABYTES = ATTACHMENT_MAX_BYTES / (1024 * 1024);

/**
 * Message input: Enter sends, Shift+Enter breaks the line, `@` opens member suggestions.
 * Files can be attached with the + button, pasted from the clipboard or dropped on the field.
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
  onCreatePoll,
  onCreateThread,
  allowEmpty = false,
  gifs = false,
  focusKey,
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
  /** Which tab of the emoji and GIF panel is open, if any. */
  const [picker, setPicker] = useState<ExpressionTab | null>(null);

  // Grow with the content, up to a few lines.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // The field grows with the text up to a share of the window; past that it keeps its size
    // and the text scrolls inside. `scrollHeight` leaves the borders out, and without them the
    // field would always be a hair too short and show a scrollbar.
    const borders = element.offsetHeight - element.clientHeight;
    const limit = Math.max(120, Math.round(window.innerHeight * 0.4));
    element.style.height = 'auto';
    const wanted = element.scrollHeight + borders;
    element.style.height = `${Math.min(wanted, limit)}px`;
    element.style.overflowY = wanted > limit ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (!autoFocus) return;
    const element = ref.current;
    element?.focus();
    element?.setSelectionRange(element.value.length, element.value.length);
  }, [autoFocus]);

  useEffect(() => {
    if (focusKey !== undefined && focusKey !== null) ref.current?.focus();
  }, [focusKey]);

  // Previews are object URLs: release whatever is still pending when the composer goes away.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  });
  useEffect(
    () => () => {
      for (const entry of pendingRef.current) if (entry.url) URL.revokeObjectURL(entry.url);
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
      if (file.size === 0) {
        problem = 'ESSE ARQUIVO ESTÁ VAZIO.';
      } else if (file.size > ATTACHMENT_MAX_BYTES) {
        problem = `CADA ARQUIVO PODE TER ATÉ ${MAX_MEGABYTES} MB.`;
      } else if (pending.length + accepted.length >= ATTACHMENT_MAX_PER_MESSAGE) {
        problem = `ATÉ ${ATTACHMENT_MAX_PER_MESSAGE} ARQUIVOS POR MENSAGEM.`;
      } else {
        accepted.push({
          key: crypto.randomUUID(),
          file,
          url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
        });
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
      if (gone?.url) URL.revokeObjectURL(gone.url);
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
      for (const entry of pending) if (entry.url) URL.revokeObjectURL(entry.url);
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

  /** A GIF goes out on its own, as its link; whatever is being typed stays in the field. */
  const sendGif = async (url: string) => {
    setPicker(null);
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(url, []);
    } catch (failure) {
      setError(describeError(failure, 'NÃO FOI POSSÍVEL ENVIAR O GIF.').toUpperCase());
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
      {picker && (
        <ExpressionPicker
          tab={picker}
          onTab={setPicker}
          gifs={gifs}
          onEmoji={(emoji) => {
            const position = ref.current?.selectionStart ?? caret;
            insert(emoji, position, ref.current?.selectionEnd ?? position);
          }}
          onGif={(gif) => void sendGif(gif.url)}
          onClose={() => setPicker(null)}
        />
      )}

      {pending.length > 0 && (
        <ul aria-label="Arquivos a enviar" className="mb-2 flex flex-wrap gap-2">
          {pending.map((entry) => (
            <li
              key={entry.key}
              className={cx(
                'anim-rise relative h-20 border border-line-strong bg-bg',
                entry.url ? 'w-20' : 'flex w-44 flex-col justify-center gap-1 px-2 pr-7',
              )}
            >
              {entry.url ? (
                <img src={entry.url} alt={entry.file.name} className="h-full w-full object-cover" />
              ) : (
                <>
                  <span className="truncate text-xs text-fg" title={entry.file.name}>
                    {entry.file.name}
                  </span>
                  <span className="label text-muted">{formatBytes(entry.file.size)}</span>
                </>
              )}
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
              icon="plus"
              label="Anexar ou criar"
              title="Enviar um arquivo, criar um tópico ou uma enquete (também dá para colar ou arrastar arquivos)"
              className="h-9 w-9"
              disabled={busy}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                // The host keeps the menu on screen; asking for a point above the button makes it
                // open upwards, away from the field.
                openContextMenu({ x: box.left, y: box.top - 140 }, 'ADICIONAR', [
                  {
                    label: 'Enviar um arquivo',
                    disabled: pending.length >= ATTACHMENT_MAX_PER_MESSAGE,
                    onSelect: () => fileInput.current?.click(),
                  },
                  onCreateThread && { label: 'Criar tópico', onSelect: onCreateThread },
                  onCreatePoll && { label: 'Criar enquete', onSelect: onCreatePoll },
                ]);
              }}
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
          placeholder={dragging ? 'Solte o arquivo aqui' : placeholder}
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
            // A copied picture or file: attach it instead of pasting its name.
            event.preventDefault();
            addFiles(files);
          }}
        />
        {gifs && (
          <button
            type="button"
            aria-label="Buscar GIF"
            title="Buscar GIF"
            aria-expanded={picker === 'gif'}
            disabled={busy}
            // The picker closes itself on an outside press; do not let that press reopen it.
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setPicker((open) => (open === 'gif' ? null : 'gif'))}
            className={cx(
              'pressable label inline-flex h-9 shrink-0 items-center justify-center border px-2 disabled:opacity-40',
              picker === 'gif'
                ? 'border-accent text-accent'
                : 'border-line-strong text-fg hover:border-accent hover:text-accent',
            )}
          >
            GIF
          </button>
        )}
        <IconButton
          icon="smile"
          label="Emojis"
          className="h-9 w-9"
          tone={picker === 'emoji' ? 'active' : 'default'}
          aria-expanded={picker === 'emoji'}
          // The picker closes itself on an outside press; do not let that press reopen it.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => setPicker((open) => (open === 'emoji' ? null : 'emoji'))}
        />
      </div>
      {busy && pending.length > 0 && (
        <p role="status" className="label mt-1 text-muted">
          ENVIANDO {pending.length === 1 ? 'ARQUIVO' : `${pending.length} ARQUIVOS`}…
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
