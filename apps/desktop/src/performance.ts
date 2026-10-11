import { app } from 'electron';
import { keepTimersFine } from './windows-scheduling';

/** How often the process list is checked for children that started since the last pass. */
const INTERVAL_MS = 5000;

/**
 * Chromium switches for a call that keeps running behind a game. A browser treats a covered
 * window as idle and slows it down; here that window is capturing and encoding the screen.
 * Must run before the app is ready.
 */
export function applyBackgroundSwitches(): void {
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // On a machine with two graphics cards Windows hands a window like this one the weak one.
  // Capturing a game drawn by the other card then copies every frame between the two.
  app.commandLine.appendSwitch('force_high_performance_gpu');
}

/**
 * Keeps Windows from slowing the app's processes down while a game covers the window — the one
 * thing a browser tab cannot do anything about. Raising the CPU priority and the GPU scheduling
 * class was tried first and changed nothing in the measurements, so neither is done.
 */
export function keepProcessesResponsive(): void {
  const handled = new Set<number>();
  const pass = () => {
    const fresh = app
      .getAppMetrics()
      .map((metric) => metric.pid)
      .filter((pid) => !handled.has(pid));
    if (fresh.length === 0) return;
    for (const pid of fresh) handled.add(pid);
    void keepTimersFine(fresh).then((result) => {
      console.warn(`[desktop] timer throttling off: ${result}`);
    });
  };
  pass();
  setInterval(pass, INTERVAL_MS).unref();
}
