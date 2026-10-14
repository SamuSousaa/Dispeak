// Captures the sound of one program (and of the processes it started) and writes it to the
// standard output as raw PCM: 48 kHz, stereo, signed 16-bit little endian. Windows calls this a
// process loopback; it is how a stream carries the game and nothing else that plays on the PC.
//
//   dispeaker-game-audio.exe --window <handle>            the program that owns that window
//   dispeaker-game-audio.exe --covering [--exclude a,b]   the program whose window covers a
//                                                         whole monitor, front-most first
//   dispeaker-game-audio.exe --process <id>               that process
//
// The first line on the standard error is JSON: {"processId":1234,"name":"Control"}. The exit
// code is 2 when there is no such program and 3 when Windows refuses the capture (it needs
// Windows 10 2004 or newer). Closing the standard input ends the capture.
//
// Built by scripts/build-game-audio.mjs with the C# 5 compiler that ships with Windows, so no
// newer syntax here.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int result, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}

// The activation refuses a completion handler that is not free-threaded.
[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject
{
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long usual, out long minimum);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid id, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong counterPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

sealed class Activation : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEvent Done = new ManualResetEvent(false);

    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        Done.Set();
    }
}

static class Program
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BytesPerFrame = Channels * 2;

    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }

    [StructLayout(LayoutKind.Sequential)]
    struct Placement { public int Size, Flags, Show, MinX, MinY, MaxX, MaxY; public Rect Normal; }

    delegate bool WindowVisitor(IntPtr window, IntPtr state);

    [DllImport("user32.dll")] static extern bool EnumWindows(WindowVisitor visitor, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string device,
        ref Guid id,
        IntPtr parameters,
        IActivateAudioInterfaceCompletionHandler handler,
        out IActivateAudioInterfaceAsyncOperation operation);

    [MTAThread]
    static int Main(string[] arguments)
    {
        uint target = 0;
        var excluded = new HashSet<uint>();
        bool covering = false;
        for (int i = 0; i < arguments.Length; i++)
        {
            if (arguments[i] == "--covering") covering = true;
            else if (arguments[i] == "--window" && i + 1 < arguments.Length)
            {
                long handle;
                if (long.TryParse(arguments[++i], out handle)) GetWindowThreadProcessId(new IntPtr(handle), out target);
            }
            else if (arguments[i] == "--process" && i + 1 < arguments.Length) uint.TryParse(arguments[++i], out target);
            else if (arguments[i] == "--exclude" && i + 1 < arguments.Length)
            {
                foreach (string part in arguments[++i].Split(','))
                {
                    uint id;
                    if (uint.TryParse(part, out id)) excluded.Add(id);
                }
            }
        }
        if (covering) target = FindCovering(excluded);
        if (target == 0 || excluded.Contains(target)) return 2;

        IAudioClient client;
        try
        {
            client = Activate(target);
        }
        catch (Exception error)
        {
            Report("{\"error\":\"" + Escape(error.Message) + "\"}");
            return 3;
        }

        var ready = new AutoResetEvent(false);
        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 1); // PCM
        Marshal.WriteInt16(format, 2, Channels);
        Marshal.WriteInt32(format, 4, SampleRate);
        Marshal.WriteInt32(format, 8, SampleRate * BytesPerFrame);
        Marshal.WriteInt16(format, 12, BytesPerFrame);
        Marshal.WriteInt16(format, 14, 16);
        Marshal.WriteInt16(format, 16, 0);
        // AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, 20 ms of buffer.
        int result = client.Initialize(0, 0x00020000 | 0x00040000, 200000, 0, format, IntPtr.Zero);
        Marshal.FreeHGlobal(format);
        if (result < 0) return Refused("Initialize", result);
        Guid captureId = typeof(IAudioCaptureClient).GUID;
        object service;
        result = client.GetService(ref captureId, out service);
        if (result < 0) return Refused("GetService", result);
        var capture = (IAudioCaptureClient)service;
        result = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        if (result < 0) return Refused("SetEventHandle", result);
        result = client.Start();
        if (result < 0) return Refused("Start", result);

        Report("{\"processId\":" + target + ",\"name\":\"" + Escape(NameOf(target)) + "\"}");

        // Whoever started this closes its standard input to end it, or dies and closes it anyway.
        var watcher = new Thread(delegate ()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                var scratch = new byte[64];
                while (input.Read(scratch, 0, scratch.Length) > 0) { }
            }
            catch (IOException) { }
            Environment.Exit(0);
        });
        watcher.IsBackground = true;
        watcher.Start();

        Stream output = Console.OpenStandardOutput();
        var buffer = new byte[SampleRate * BytesPerFrame / 10];
        Process process = null;
        try { process = Process.GetProcessById((int)target); } catch (Exception) { }
        try
        {
            while (true)
            {
                if (!ready.WaitOne(500))
                {
                    // Nothing is playing. A good moment to see whether the program is still there.
                    try { if (process != null && process.HasExited) return 0; } catch (Exception) { }
                    continue;
                }
                uint frames;
                while (capture.GetNextPacketSize(out frames) >= 0 && frames > 0)
                {
                    IntPtr data;
                    uint flags;
                    ulong devicePosition, counterPosition;
                    if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out counterPosition) < 0) break;
                    int size = (int)frames * BytesPerFrame;
                    if (size > buffer.Length) buffer = new byte[size];
                    // AUDCLNT_BUFFERFLAGS_SILENT: the bytes are to be taken as silence.
                    if ((flags & 2) != 0) Array.Clear(buffer, 0, size);
                    else Marshal.Copy(data, buffer, 0, size);
                    capture.ReleaseBuffer(frames);
                    output.Write(buffer, 0, size);
                }
                output.Flush();
            }
        }
        catch (IOException)
        {
            return 0;
        }
    }

    static IAudioClient Activate(uint processId)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS: process loopback, this process, its whole tree included.
        IntPtr parameters = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(parameters, 0, 1);
        Marshal.WriteInt32(parameters, 4, (int)processId);
        Marshal.WriteInt32(parameters, 8, 0);
        // A PROPVARIANT holding that as a blob (VT_BLOB): type, padding, size, pointer.
        IntPtr variant = Marshal.AllocHGlobal(24);
        for (int offset = 0; offset < 24; offset += 4) Marshal.WriteInt32(variant, offset, 0);
        Marshal.WriteInt16(variant, 0, 65);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, 16, parameters);
        try
        {
            var handler = new Activation();
            Guid clientId = typeof(IAudioClient).GUID;
            IActivateAudioInterfaceAsyncOperation operation;
            ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref clientId, variant, handler, out operation);
            if (!handler.Done.WaitOne(5000)) throw new TimeoutException("activation did not complete");
            int result;
            object activated;
            operation.GetActivateResult(out result, out activated);
            if (result < 0) Marshal.ThrowExceptionForHR(result);
            return (IAudioClient)activated;
        }
        finally
        {
            Marshal.FreeHGlobal(variant);
            Marshal.FreeHGlobal(parameters);
        }
    }

    // The front-most window that takes a whole monitor and belongs to a program: a game, a film.
    // Overlays (click-through or never activated), the desktop itself and hidden windows do not
    // count. A full-screen game minimises itself when the user leaves it to start the share, so
    // failing a window on screen, a minimised one that would cover a monitor is taken.
    static uint FindCovering(HashSet<uint> excluded)
    {
        uint found = 0;
        uint minimised = 0;
        EnumWindows(delegate (IntPtr window, IntPtr state)
        {
            if (!IsWindowVisible(window)) return true;
            int cloaked;
            // DWMWA_CLOAKED
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
            // GWL_EXSTYLE; WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
            long style = GetWindowLongPtr(window, -20).ToInt64();
            if ((style & (0x20 | 0x80 | 0x08000000)) != 0) return true;
            var name = new StringBuilder(64);
            GetClassName(window, name, name.Capacity);
            string kind = name.ToString();
            if (kind == "Progman" || kind == "WorkerW" || kind == "Shell_TrayWnd") return true;
            bool iconic = IsIconic(window);
            Rect rect;
            if (iconic)
            {
                var placement = new Placement();
                placement.Size = Marshal.SizeOf(typeof(Placement));
                if (!GetWindowPlacement(window, ref placement)) return true;
                rect = placement.Normal;
            }
            else if (!GetWindowRect(window, out rect)) return true;
            var info = new MonitorInfo();
            info.Size = Marshal.SizeOf(typeof(MonitorInfo));
            // MONITOR_DEFAULTTONEAREST
            if (!GetMonitorInfo(MonitorFromRect(ref rect, 2), ref info)) return true;
            Rect monitor = info.Monitor;
            if (rect.Left > monitor.Left || rect.Top > monitor.Top || rect.Right < monitor.Right || rect.Bottom < monitor.Bottom) return true;
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == 0 || excluded.Contains(processId)) return true;
            if (iconic)
            {
                if (minimised == 0) minimised = processId;
                return true;
            }
            found = processId;
            return false;
        }, IntPtr.Zero);
        return found != 0 ? found : minimised;
    }

    // What the program calls itself, or the name of its file when that cannot be read.
    static string NameOf(uint processId)
    {
        try
        {
            Process process = Process.GetProcessById((int)processId);
            try
            {
                string described = process.MainModule.FileVersionInfo.FileDescription;
                if (!string.IsNullOrWhiteSpace(described)) return described.Trim();
            }
            catch (Exception) { }
            return process.ProcessName;
        }
        catch (Exception)
        {
            return "";
        }
    }

    static int Refused(string step, int result)
    {
        Report("{\"error\":\"" + step + " 0x" + result.ToString("X8") + "\"}");
        return 3;
    }

    static string Escape(string text)
    {
        var escaped = new StringBuilder();
        foreach (char character in text)
        {
            if (character == '"' || character == '\\') escaped.Append('\\').Append(character);
            else if (character >= ' ') escaped.Append(character);
        }
        return escaped.ToString();
    }

    static void Report(string line)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
        Stream error = Console.OpenStandardError();
        error.Write(bytes, 0, bytes.Length);
        error.Flush();
    }
}
