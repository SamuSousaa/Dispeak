import { spawn } from 'node:child_process';
import { z } from 'zod';

/**
 * Asks Windows which window the user is looking at. Electron only knows its own windows, and
 * the question matters at the moment a global shortcut starts a screen share: the window in
 * front is then the game. user32 has no Node binding, so PowerShell asks, with the script
 * passed on the command line.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Dispeaker -Name Front -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
[StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
[DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
[DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
'@
$window = [Dispeaker.Front]::GetForegroundWindow()
$processId = 0
[void][Dispeaker.Front]::GetWindowThreadProcessId($window, [ref]$processId)
$rect = New-Object Dispeaker.Front+Rect
[void][Dispeaker.Front]::GetWindowRect($window, [ref]$rect)
$info = New-Object Dispeaker.Front+MonitorInfo
$info.Size = 40
# MONITOR_DEFAULTTONEAREST
[void][Dispeaker.Front]::GetMonitorInfo([Dispeaker.Front]::MonitorFromWindow($window, 2), [ref]$info)
$m = $info.Monitor
$covers = ($rect.Left -le $m.Left) -and ($rect.Top -le $m.Top) -and ($rect.Right -ge $m.Right) -and ($rect.Bottom -ge $m.Bottom)
'{"handle":' + $window.ToInt64() + ',"processId":' + $processId + ',"coversScreen":' + $covers.ToString().ToLower() + '}'
`;

const answerSchema = z.object({
  handle: z.number().int().positive(),
  processId: z.number().int().nonnegative(),
  /** The window takes its whole monitor: a game, a film, a presentation. */
  coversScreen: z.boolean(),
});
export type ForegroundWindow = z.infer<typeof answerSchema>;

/** The window in front right now, or `null` when it cannot be told (not Windows, no answer). */
export function foregroundWindow(): Promise<ForegroundWindow | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    // PowerShell takes an encoded command as base64 of UTF-16.
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', () => resolve(null));
    child.once('close', () => {
      try {
        const parsed = answerSchema.safeParse(JSON.parse(output.trim()));
        resolve(parsed.success ? parsed.data : null);
      } catch {
        resolve(null);
      }
    });
  });
}
