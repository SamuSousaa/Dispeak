import { spawn } from 'node:child_process';
import { hostTimersSchema } from '@frequencia/shared';
import { nativeHost } from './native-host';

/**
 * Windows 11 ignores the fine timers of a process whose windows are all covered and wakes it on
 * the 15.6 ms system tick instead. The screen capturer paces itself with those timers, so behind
 * a full-screen game every frame waits for a whole number of ticks: 32 frames a second where 60
 * were asked (measured on one machine: 35 against 55 with this applied), 21 where one capture
 * takes a little longer. `PROCESS_POWER_THROTTLING` with the control bits set and the state
 * bits clear takes that decision, and the efficiency mode, away from the system.
 *
 * The call lives in kernel32 and has no Node binding: the app's Windows helper makes it. Should
 * the helper be missing, PowerShell does, with the script on the command line; it matters too
 * much for the frame rate of a stream to go without.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Dispeaker -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
[DllImport("kernel32.dll")] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref Throttling info, int size);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
$done = @()
foreach ($id in @(__PIDS__)) {
  # PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
  $handle = [Dispeaker.Native]::OpenProcess(0x1200, $false, $id)
  if ($handle -eq [IntPtr]::Zero) { continue }
  $state = New-Object Dispeaker.Native+Throttling
  $state.Version = 1
  # EXECUTION_SPEED (1) | IGNORE_TIMER_RESOLUTION (4), both switched off.
  $state.ControlMask = 5
  $state.StateMask = 0
  # ProcessPowerThrottling = 4
  $timers = [Dispeaker.Native]::SetProcessInformation($handle, 4, [ref]$state, 12)
  [void][Dispeaker.Native]::CloseHandle($handle)
  $done += "$id=$timers"
}
$done -join '; '
`;

/** Exempts the given processes from timer throttling. Resolves with what happened, for the log. */
export async function keepTimersFine(pids: number[]): Promise<string> {
  if (process.platform !== 'win32' || pids.length === 0) return 'skipped';
  try {
    const { done } = await nativeHost.request('keepTimersFine', { pids }, hostTimersSchema);
    return `helper: ${done.length}/${pids.length}`;
  } catch {
    return withPowerShell(pids);
  }
}

function withPowerShell(pids: number[]): Promise<string> {
  return new Promise((resolve) => {
    const script = SCRIPT.replace('__PIDS__', pids.join(', '));
    // PowerShell takes an encoded command as base64 of UTF-16.
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', () => resolve('powershell-unavailable'));
    child.once('close', () => resolve(output.trim() || 'no-answer'));
  });
}
