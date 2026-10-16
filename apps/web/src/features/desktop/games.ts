import type { DesktopGame, GameChoices } from '@frequencia/shared';
import { useEffect } from 'react';
import { create } from 'zustand';
import { changeAccountSettings, useAccountSettings } from '../settings/account-settings';
import { useSettingsStore } from '../settings/settings-store';
import { startScreenShare } from '../voice/voice-actions';
import { gateway } from '../gateway/gateway-client';
import { desktop } from './desktop';

/** Games running on this machine, as the desktop app reports them; empty in a browser. */
export const useRunningGames = create<DesktopGame[]>(() => []);

/** The games running, without the programs the user said are not games. */
export function useGames(): DesktopGame[] {
  const games = useRunningGames();
  const hidden = useAccountSettings((settings) => settings.games.hidden);
  return games.filter((game) => !hidden.includes(game.exe));
}

/** The game to offer to stream: the one on screen first, then one with a window at all. */
export function useMainGame(): DesktopGame | null {
  const games = useGames().filter((game) => game.windowHandle !== null);
  return games.find((game) => game.fullscreen) ?? games[0] ?? null;
}

/** The game being played: the one on screen first. */
export function usePlayingGame(): DesktopGame | null {
  const games = useGames();
  return games.find((game) => game.fullscreen) ?? games[0] ?? null;
}

/** Shows the others the game being played, unless the user turned that off. */
export function useShareActivity(): void {
  const game = usePlayingGame();
  const share = useAccountSettings((settings) => settings.shareActivity);
  const name = share && game ? game.name : null;
  useEffect(() => {
    gateway.setActivity(name);
  }, [name]);
  // Closing the app: the others stop seeing the game now, not when the session expires.
  useEffect(() => {
    const leave = () => gateway.setActivity(null);
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
}

/** Keeps the list of games running current while the app is open. */
export function useGameDetection(): void {
  const added = useAccountSettings((settings) => settings.games.added);
  const key = added.join('\n');
  useEffect(() => {
    if (!desktop?.games) return;
    const stop = desktop.games.watch(key ? key.split('\n') : [], (games) =>
      useRunningGames.setState(games, true),
    );
    return () => {
      stop();
      useRunningGames.setState([], true);
    };
  }, [key]);
}

/** Streams a game's window right away, with the quality used last time. */
export async function streamGame(game: DesktopGame): Promise<void> {
  if (!desktop?.games || game.windowHandle === null) return;
  await desktop.games.shareWindow(game.windowHandle);
  startScreenShare(useSettingsStore.getState().sharePreset);
}

function changeGames(update: (games: GameChoices) => GameChoices): void {
  changeAccountSettings({ games: update(useAccountSettings.getState().games) });
}

/** Detection got it wrong: this program is not a game. */
export function hideGame(exe: string): void {
  changeGames((games) => ({
    added: games.added.filter((entry) => entry !== exe),
    hidden: [...new Set([...games.hidden, exe])],
  }));
}

export function unhideGame(exe: string): void {
  changeGames((games) => ({ ...games, hidden: games.hidden.filter((entry) => entry !== exe) }));
}

/** A program the detection does not know: the user says it is a game. */
export function addGame(exe: string): void {
  changeGames((games) => ({
    added: [...new Set([...games.added, exe.toLowerCase()])],
    hidden: games.hidden.filter((entry) => entry !== exe.toLowerCase()),
  }));
}

export function removeGame(exe: string): void {
  changeGames((games) => ({ ...games, added: games.added.filter((entry) => entry !== exe) }));
}
