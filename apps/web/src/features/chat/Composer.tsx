import { EVERYONE_MENTION, MESSAGE_MAX_LENGTH, type Guild } from '@frequencia/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../lib/cx';
import { memberName } from '../guilds/permissions';
import { mentionQueryAt, toWireContent } from './mentions';

interface ComposerProps {
  guild: Guild;
  /** Shown as the placeholder, e.g. the channel name. */
  placeholder: string;
  initialText?: string;
  canMentionEveryone: boolean;
  /** Resolves when the message was accepted; a rejection keeps the text for a retry. */
  onSubmit: (content: string) => Promise<void>;
  onCancel?: () => void;
  onTyping?: () => void;
  autoFocus?: boolean;
}

interface Suggestion {
  key: string;
  label: string;
  hint: string;
}

const MAX_SUGGESTIONS = 6;

/** Message input: Enter sends, Shift+Enter breaks the line, `@` opens member suggestions. */
export function Composer({
  guild,
  placeholder,
  initialText = '',
  canMentionEveryone,
  onSubmit,
  onCancel,
  onTyping,
  autoFocus = false,
}: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [caret, setCaret] = useState(initialText.length);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

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

  const pick = (suggestion: Suggestion) => {
    if (!query) return;
    const next = `${text.slice(0, query.start)}${suggestion.label} ${text.slice(caret)}`;
    const position = query.start + suggestion.label.length + 1;
    setText(next);
    setCaret(position);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  };

  const submit = async () => {
    const content = toWireContent(text, guild).trim();
    if (!content || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit(content);
      setText('');
      setCaret(0);
    } catch {
      setFailed(true);
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
    <div className="relative">
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mencionar"
          className="absolute bottom-full left-0 z-10 mb-1 w-72 max-w-full border border-line-strong bg-surface-2"
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
      <textarea
        ref={ref}
        className="field block font-sans text-sm leading-5"
        style={{ fontFamily: 'var(--font-body)' }}
        rows={1}
        value={text}
        maxLength={MESSAGE_MAX_LENGTH}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={failed}
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setSelected(0);
          setDismissed(false);
          if (event.target.value.trim()) onTyping?.();
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {failed && (
        <p role="alert" className="label mt-1 text-danger">
          NÃO FOI POSSÍVEL ENVIAR. ENTER PARA TENTAR DE NOVO.
        </p>
      )}
    </div>
  );
}
