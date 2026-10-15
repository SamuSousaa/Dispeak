import type { GameSource, RunningWindow } from '@frequencia/shared';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { Loading } from '../../components/Loading';
import { attempt } from '../../components/Toast';
import { desktop } from '../desktop/desktop';
import { addGame, hideGame, removeGame, unhideGame, useGames } from '../desktop/games';
import { useAccountSettings } from './account-settings';

const SOURCE_LABELS: Record<GameSource, string> = {
  steam: 'STEAM',
  epic: 'EPIC',
  xbox: 'XBOX',
  gog: 'GOG',
  added: 'ADICIONADO POR VOCÊ',
  fullscreen: 'TELA CHEIA',
};

const row =
  'flex items-center justify-between gap-3 border-b border-line px-3 py-2 last:border-b-0';

/** The games running now, as detected, with a way to say one is not a game. */
export function PlayingNow() {
  const games = useGames();
  return (
    <>
      <p className="text-xs text-muted">
        O app reconhece os jogos da Steam, Epic, Xbox e GOG instalados neste PC e qualquer outro
        programa em tela cheia. O jogo aparece no topo do seletor de transmissão e ao lado da
        chamada, para transmitir com um clique.
      </p>
      {games.length === 0 ? (
        <p className="label text-muted">NENHUM JOGO ABERTO</p>
      ) : (
        <ul className="border border-line" data-testid="games-playing">
          {games.map((game) => (
            <li key={game.exe} className={row}>
              <span className="flex min-w-0 items-center gap-2">
                {game.icon && <img src={game.icon} alt="" className="h-6 w-6 shrink-0" />}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{game.name}</span>
                  <span className="label block truncate text-muted">
                    {SOURCE_LABELS[game.source]} · {game.exe}
                  </span>
                </span>
              </span>
              <Button onClick={() => hideGame(game.exe)}>NÃO É UM JOGO</Button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Programs the user calls games, and a way to pick another one among the windows open. */
export function AddedGames() {
  const added = useAccountSettings((settings) => settings.games.added);
  const [windows, setWindows] = useState<RunningWindow[] | null>(null);
  const [loading, setLoading] = useState(false);

  const choose = () => {
    setLoading(true);
    attempt(async () => {
      try {
        setWindows((await desktop?.games?.runningWindows()) ?? []);
      } finally {
        setLoading(false);
      }
    });
  };

  return (
    <>
      <p className="text-xs text-muted">
        Para um jogo que não foi reconhecido, abra-o e escolha o programa na lista. Vale para todos
        os seus computadores.
      </p>
      {added.length > 0 && (
        <ul className="border border-line" data-testid="games-added">
          {added.map((exe) => (
            <li key={exe} className={row}>
              <span className="label truncate text-fg">{exe}</span>
              <Button onClick={() => removeGame(exe)}>REMOVER</Button>
            </li>
          ))}
        </ul>
      )}
      {windows === null ? (
        <Button className="self-start" onClick={choose} disabled={loading}>
          {loading ? 'PROCURANDO' : 'ESCOLHER PROGRAMA ABERTO'}
        </Button>
      ) : loading ? (
        <Loading label="PROCURANDO" />
      ) : (
        <ul className="border border-line" data-testid="running-windows">
          {windows
            .filter((entry) => !added.includes(entry.exe))
            .map((entry) => (
              <li key={entry.exe} className={row}>
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{entry.title}</span>
                  <span className="label block truncate text-muted">{entry.exe}</span>
                </span>
                <Button
                  onClick={() => {
                    addGame(entry.exe);
                    setWindows(null);
                  }}
                >
                  É UM JOGO
                </Button>
              </li>
            ))}
          <li className="px-3 py-2">
            <Button onClick={() => setWindows(null)}>CANCELAR</Button>
          </li>
        </ul>
      )}
    </>
  );
}

/** Programs the user said are not games. */
export function HiddenGames() {
  const hidden = useAccountSettings((settings) => settings.games.hidden);
  if (hidden.length === 0) return <p className="label text-muted">NENHUM</p>;
  return (
    <ul className="border border-line">
      {hidden.map((exe) => (
        <li key={exe} className={row}>
          <span className="label truncate text-fg">{exe}</span>
          <Button onClick={() => unhideGame(exe)}>É UM JOGO</Button>
        </li>
      ))}
    </ul>
  );
}
