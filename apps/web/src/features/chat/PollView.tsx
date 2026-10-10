import type { Message } from '@frequencia/shared';
import { cx } from '../../lib/cx';
import { attempt } from '../../components/Toast';
import { chatApi } from './chat-store';

/** A poll carried by a message: pick an option to vote, pick it again to take the vote back. */
export function PollView({ message, userId }: { message: Message; userId: string }) {
  const poll = message.poll;
  if (!poll) return null;
  const mine = poll.options.filter((option) => option.voterIds.includes(userId));
  const voters = new Set(poll.options.flatMap((option) => option.voterIds)).size;
  const most = Math.max(1, ...poll.options.map((option) => option.voterIds.length));

  const choose = (optionId: string) => {
    const chosen = mine.some((option) => option.id === optionId);
    const next = poll.multiple
      ? chosen
        ? mine.filter((option) => option.id !== optionId).map((option) => option.id)
        : [...mine.map((option) => option.id), optionId]
      : chosen
        ? []
        : [optionId];
    // The new totals arrive through the gateway, for everyone at once.
    attempt(() => chatApi.vote(message.id, next));
  };

  return (
    <div
      data-testid="poll"
      className="my-1 flex max-w-md flex-col gap-2 border border-line-strong bg-surface p-3"
    >
      <p className="label text-muted">ENQUETE{poll.multiple ? ' · VÁRIAS RESPOSTAS' : ''}</p>
      <p className="text-sm font-medium text-fg">{poll.question}</p>
      <ul className="flex flex-col gap-1.5">
        {poll.options.map((option) => {
          const votes = option.voterIds.length;
          const chosen = option.voterIds.includes(userId);
          return (
            <li key={option.id}>
              <button
                type="button"
                data-testid="poll-option"
                aria-pressed={chosen}
                onClick={() => choose(option.id)}
                className={cx(
                  'pressable relative flex w-full items-center justify-between gap-3 overflow-hidden border px-2.5 py-1.5 text-left',
                  chosen ? 'border-accent' : 'border-line-strong hover:border-accent',
                )}
              >
                {/* How this option is doing against the leading one. */}
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 bg-surface-2 transition-[width]"
                  style={{ width: `${(votes / most) * 100}%` }}
                />
                <span
                  className={cx('relative min-w-0 text-sm', chosen ? 'text-accent' : 'text-fg')}
                >
                  {option.text}
                </span>
                <span className="label relative shrink-0 text-muted">
                  {votes} {votes === 1 ? 'VOTO' : 'VOTOS'}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="label text-muted">
        {voters === 0
          ? 'NINGUÉM VOTOU AINDA'
          : `${voters} ${voters === 1 ? 'PESSOA VOTOU' : 'PESSOAS VOTARAM'}`}
      </p>
    </div>
  );
}
