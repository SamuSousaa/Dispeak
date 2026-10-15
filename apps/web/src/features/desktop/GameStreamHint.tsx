import { attempt } from '../../components/Toast';
import { streamGame, useMainGame } from './games';

/**
 * In a call, with a game open and nothing being shared: the game's name and a way to stream
 * it with one click, as Discord offers.
 */
export function GameStreamHint() {
  const game = useMainGame();
  if (!game) return null;
  return (
    <div
      className="anim-rise mt-1.5 flex items-center gap-2 border border-line bg-surface-2 px-2 py-1"
      data-testid="game-stream-hint"
    >
      {game.icon && <img src={game.icon} alt="" className="h-6 w-6 shrink-0" />}
      <span className="flex min-w-0 flex-1 flex-col" title={game.name}>
        <span className="label text-muted">JOGANDO</span>
        <span className="label truncate text-fg">{game.name.toUpperCase()}</span>
      </span>
      <button
        type="button"
        className="label shrink-0 text-muted transition-colors hover:text-accent"
        onClick={() => attempt(() => streamGame(game))}
      >
        [ TRANSMITIR ]
      </button>
    </div>
  );
}
