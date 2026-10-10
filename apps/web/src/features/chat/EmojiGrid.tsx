import { openContextMenu } from '../../components/ContextMenu';
import { EMOJI_GROUPS } from './emoji';

/** Offered first when reacting. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];

/** The built-in emoji set, grouped. The parent decides where it floats and how tall it is. */
export function EmojiGrid({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <>
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
                // Keep focus (and the caret) where it was.
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
    </>
  );
}

/** Floating emoji grid for reacting to a message, opened at a point of the screen. */
export function openReactionPicker(
  point: { x: number; y: number },
  onPick: (emoji: string) => void,
): void {
  openContextMenu(point, 'REAGIR', [
    {
      type: 'custom',
      key: 'emojis',
      render: (close) => (
        <div className="-mx-3 -my-2 max-h-72 overflow-y-auto">
          <EmojiGrid
            onPick={(emoji) => {
              close();
              onPick(emoji);
            }}
          />
        </div>
      ),
    },
  ]);
}
