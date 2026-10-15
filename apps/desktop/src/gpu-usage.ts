import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  DESKTOP_GPU_USAGE,
  DESKTOP_WATCH_GPU_USAGE,
  desktopWatchGpuUsageSchema,
  type DesktopGpuUsage,
} from '@frequencia/shared';
import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { config } from './config';
import { foldEngines } from './gpu-engines';
import { isAppUrl } from './navigation';

/**
 * How busy the graphics card is, engine by engine, for the app (with the capture engine and
 * any other program it started) and for the whole machine. The "GPU" column of the Task
 * Manager is the busiest engine; a stream mostly loads the video engines, a game the 3D one,
 * and only this split says which of the two a heavy stream competes with.
 *
 * Read from the Windows performance counters by one PowerShell process, every two seconds,
 * only while the page asks (a stream shared or watched).
 */
const SCRIPT = (root: number) => String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$root = ${root}
while ($true) {
  $children = @{}
  foreach ($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId) {
    $children[[int]$p.ParentProcessId] += ,[int]$p.ProcessId
  }
  $mine = New-Object 'System.Collections.Generic.HashSet[int]'
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $queue.Enqueue($root)
  while ($queue.Count -gt 0) {
    $id = $queue.Dequeue()
    if ($mine.Add($id)) { foreach ($c in $children[$id]) { if ($c -ne $id) { $queue.Enqueue($c) } } }
  }
  $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2).CounterSamples
  $app = @{}
  $all = @{}
  foreach ($s in $samples) {
    if ($s.InstanceName -match '^pid_(\d+)_(luid_\w+_phys_\d+_eng_\d+)_engtype_(.+)$') {
      $engine = $matches[2] + '|' + $matches[3]
      $all[$engine] += $s.CookedValue
      if ($mine.Contains([int]$matches[1])) { $app[$engine] += $s.CookedValue }
    }
  }
  ConvertTo-Json -Compress @{ app = $app; all = $all }
}
`;

const engineTableSchema = z.record(z.string(), z.number()).catch({});
const lineSchema = z.object({ app: engineTableSchema, all: engineTableSchema });

export function serveGpuUsage(window: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  const { webContents } = window;
  let child: ChildProcessWithoutNullStreams | null = null;

  const stop = () => {
    child?.kill();
    child = null;
  };
  const start = () => {
    if (child) return;
    const encoded = Buffer.from(SCRIPT(process.pid), 'utf16le').toString('base64');
    const started = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
    );
    child = started;
    let pending = '';
    started.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim() || webContents.isDestroyed()) continue;
        try {
          const parsed = lineSchema.safeParse(JSON.parse(line));
          if (!parsed.success) continue;
          const usage: DesktopGpuUsage = {
            app: foldEngines(parsed.data.app),
            all: foldEngines(parsed.data.all),
          };
          webContents.send(DESKTOP_GPU_USAGE, usage);
        } catch {
          // A line cut in the middle; the next one will do.
        }
      }
    });
    started.stderr.resume();
    started.once('exit', () => {
      if (child === started) child = null;
    });
  };

  ipcMain.handle(DESKTOP_WATCH_GPU_USAGE, (event, payload: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== webContents.mainFrame || !isAppUrl(frame.url, config.appUrl)) {
      throw new Error('forbidden');
    }
    if (desktopWatchGpuUsageSchema.parse(payload).on) start();
    else stop();
  });
  // A reload forgets what it asked for.
  webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) stop();
  });
  window.once('closed', () => {
    stop();
    ipcMain.removeHandler(DESKTOP_WATCH_GPU_USAGE);
  });
}
