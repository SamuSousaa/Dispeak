import { spawn } from 'node:child_process';

/**
 * Windows shares the graphics card between processes by a scheduling class of its own, apart
 * from the CPU priority. A game that keeps the card busy leaves a normal-class process a few
 * turns a second, and every captured frame needs one. Recording software asks for the realtime
 * class for the same reason. The call lives in gdi32 and has no Node binding, so PowerShell
 * makes it, with the script passed on the command line: nothing is written to disk.
 */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Dispeaker -Name Gpu -MemberDefinition @'
[DllImport("gdi32.dll")] public static extern int D3DKMTSetProcessSchedulingPriorityClass(IntPtr process, int priority);
[DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
'@
# PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
$handle = [Dispeaker.Gpu]::OpenProcess(0x1200, $false, __PID__)
if ($handle -eq [IntPtr]::Zero) { 'open-failed'; exit 1 }
# Realtime (5) first, high (4) where the system refuses it.
foreach ($class in 5, 4) {
  if ([Dispeaker.Gpu]::D3DKMTSetProcessSchedulingPriorityClass($handle, $class) -eq 0) {
    [void][Dispeaker.Gpu]::CloseHandle($handle)
    "class-$class"
    exit 0
  }
}
[void][Dispeaker.Gpu]::CloseHandle($handle)
'refused'
exit 1
`;

/** Raises the GPU scheduling class of a process. Resolves with what happened, for the log. */
export function raiseGpuPriority(pid: number): Promise<string> {
  if (process.platform !== 'win32') return Promise.resolve('unsupported');
  return new Promise((resolve) => {
    // PowerShell takes an encoded command as base64 of UTF-16.
    const script = SCRIPT.replace('__PID__', String(pid));
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
