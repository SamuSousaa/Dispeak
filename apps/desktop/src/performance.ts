import os from 'node:os';
import { app } from 'electron';
import { raiseGpuPriority } from './gpu-priority';

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
}

/**
 * Raises the CPU and GPU scheduling priority of the app's processes. A game that takes every core
 * otherwise leaves the capture and the encoder a fraction of the frames they need — the
 * one thing a browser tab cannot do anything about.
 */
export function keepProcessesResponsive(): void {
  const raised = new Set<number>();
  const raise = () => {
    for (const { pid, type } of app.getAppMetrics()) {
      if (raised.has(pid)) continue;
      // The GPU process is the one that copies every captured frame off the graphics card.
      if (type === 'GPU') {
        void raiseGpuPriority(pid).then((result) => {
          console.warn(`[desktop] gpu scheduling priority of ${pid}: ${result}`);
        });
      }
      try {
        os.setPriority(pid, os.constants.priority.PRIORITY_HIGH);
        raised.add(pid);
      } catch {
        // The process ended in the meantime, or the system refuses: the default priority stays.
      }
    }
  };
  raise();
  setInterval(raise, INTERVAL_MS).unref();
}
