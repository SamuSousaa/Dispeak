// The sound of a screen share, without the voice chats. Windows can capture the audio of one
// process tree (a "process loopback"); this captures one or several and writes the mix to the
// standard output as raw PCM: 48 kHz, stereo, signed 16-bit little endian, at a steady pace.
//
//   dispeaker-game-audio.exe --window <handle>    the program that owns that window
//   dispeaker-game-audio.exe --covering           the program whose window covers a whole
//                                                 monitor, front-most first
//   dispeaker-game-audio.exe --process <id>       that process
//   ... --or-mix                                  when no such program: everything that plays,
//                                                 except voice chats and the excluded processes
//   ... --exclude <id,id>                         never these processes (the app itself)
//   dispeaker-game-audio.exe --describe <handle>  no capture: whether that window covers a
//                                                 whole monitor, and where it is (JSON)
//   dispeaker-game-audio.exe --monitors           no capture: the monitors of each graphics
//                                                 card, as the screen capture numbers them (JSON)
//
// The first line on the standard error is JSON: {"processId":1234,"name":"Control"} for one
// program, {"mix":true} for the mix. The exit code is 2 when there is nothing to capture and 3
// when Windows refuses (it needs Windows 10 2004 or newer). Closing the standard input ends it.
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

// Only the methods called are declared with their real signatures; the others hold their place
// in the table.
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator
{
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints();
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate(ref Guid id, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object activated);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    [PreserveSig] int GetAudioSessionControl();
    [PreserveSig] int GetSimpleAudioVolume();
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    [PreserveSig] int GetState();
    [PreserveSig] int GetDisplayName();
    [PreserveSig] int SetDisplayName();
    [PreserveSig] int GetIconPath();
    [PreserveSig] int SetIconPath();
    [PreserveSig] int GetGroupingParam();
    [PreserveSig] int SetGroupingParam();
    [PreserveSig] int RegisterAudioSessionNotification();
    [PreserveSig] int UnregisterAudioSessionNotification();
    [PreserveSig] int GetSessionIdentifier();
    [PreserveSig] int GetSessionInstanceIdentifier();
    [PreserveSig] int GetProcessId(out uint processId);
}

[ComImport, Guid("770AAE78-F26F-4DBA-A829-253C83D1B387")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIFactory1
{
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    [PreserveSig] int EnumAdapters(uint index, out IDXGIAdapter adapter);
}

[ComImport, Guid("2411E7E1-12AC-4CCF-BD14-9798E8534DC0")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIAdapter
{
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    [PreserveSig] int EnumOutputs(uint index, out IDXGIOutput output);
}

[ComImport, Guid("AE02EEDB-C735-4690-8D52-5A8DC20213AA")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutput
{
    [PreserveSig] int SetPrivateData();
    [PreserveSig] int SetPrivateDataInterface();
    [PreserveSig] int GetPrivateData();
    [PreserveSig] int GetParent();
    [PreserveSig] int GetDesc(out OutputDescription description);
}

[StructLayout(LayoutKind.Sequential)]
struct Rect { public int Left, Top, Right, Bottom; }

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct OutputDescription
{
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public Rect Desktop;
    public int Attached;
    public int Rotation;
    public IntPtr Monitor;
}

sealed class Activation : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEvent Done = new ManualResetEvent(false);

    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        Done.Set();
    }
}

// The sound of one process tree, kept until the mixer takes it.
sealed class Source
{
    // Held back before it plays (again), so a late packet does not become a gap: 30 ms.
    const int StartFrames = 1440;
    // Above this the mixer is not keeping up with the device: the oldest sound goes.
    const int MaxFrames = 9600;

    readonly Queue<short[]> pieces = new Queue<short[]>();
    short[] head;
    int offset;
    int frames;
    bool playing;
    public readonly uint ProcessId;

    public Source(uint processId)
    {
        ProcessId = processId;
    }

    public void Push(short[] piece)
    {
        lock (pieces)
        {
            pieces.Enqueue(piece);
            frames += piece.Length / 2;
            while (frames > MaxFrames && pieces.Count > 1)
            {
                frames -= pieces.Dequeue().Length / 2;
            }
        }
    }

    // Adds up to `count` frames to `mix`; silence where there is nothing to play.
    public void MixInto(int[] mix, int count)
    {
        lock (pieces)
        {
            if (!playing && frames >= StartFrames) playing = true;
            if (!playing) return;
            for (int frame = 0; frame < count; frame++)
            {
                if (head == null || offset >= head.Length)
                {
                    if (pieces.Count == 0) { playing = false; head = null; return; }
                    head = pieces.Dequeue();
                    offset = 0;
                }
                mix[frame * 2] += head[offset];
                mix[frame * 2 + 1] += head[offset + 1];
                offset += 2;
                frames -= 1;
            }
        }
    }
}

static class Program
{
    const int SampleRate = 48000;
    const int Channels = 2;
    const int BytesPerFrame = Channels * 2;

    // Voice chats: what is said there must not go out with the stream. Matched against the
    // name of the process file, without ".exe".
    static readonly string[] VoiceChats =
    {
        "discord", "discordptb", "discordcanary", "dispeaker", "ts3client_win64", "ts3client_win32",
        "teamspeak", "skype", "zoom", "ms-teams", "teams", "whatsapp", "telegram", "mumble", "slack",
    };

    [StructLayout(LayoutKind.Sequential)]
    struct MonitorInfo { public int Size; public Rect Monitor; public Rect Work; public uint Flags; }

    [StructLayout(LayoutKind.Sequential)]
    struct Placement { public int Size, Flags, Show, MinX, MinY, MaxX, MaxY; public Rect Normal; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public int Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeap;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

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
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid id, out IDXGIFactory1 factory);
    [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
    static extern void ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string device,
        ref Guid id,
        IntPtr parameters,
        IActivateAudioInterfaceCompletionHandler handler,
        out IActivateAudioInterfaceAsyncOperation operation);

    static readonly List<Source> sources = new List<Source>();

    [MTAThread]
    static int Main(string[] arguments)
    {
        // Real pixels, whatever the scaling of each monitor (per-monitor aware, version 2).
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
        if (arguments.Length == 1 && arguments[0] == "--monitors") return Monitors();
        if (arguments.Length == 2 && arguments[0] == "--describe")
        {
            long described;
            if (!long.TryParse(arguments[1], out described)) return 2;
            return Describe(new IntPtr(described));
        }

        uint target = 0;
        var excluded = new HashSet<uint>();
        bool covering = false;
        bool orMix = false;
        for (int i = 0; i < arguments.Length; i++)
        {
            if (arguments[i] == "--covering") covering = true;
            else if (arguments[i] == "--or-mix") orMix = true;
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
        if (target != 0 && excluded.Contains(target)) target = 0;

        if (target != 0)
        {
            try
            {
                StartSource(target);
            }
            catch (Exception error)
            {
                Report("{\"error\":\"" + Escape(error.Message) + "\"}");
                return 3;
            }
            Report("{\"processId\":" + target + ",\"name\":\"" + Escape(NameOf(target)) + "\"}");
        }
        else if (orMix)
        {
            // A first look decides whether Windows can do this at all; later ones only add.
            try
            {
                AddPlaying(excluded, true);
            }
            catch (Exception error)
            {
                Report("{\"error\":\"" + Escape(error.Message) + "\"}");
                return 3;
            }
            Report("{\"mix\":true}");
            var watcher = new Thread(delegate ()
            {
                while (true)
                {
                    Thread.Sleep(3000);
                    try { AddPlaying(excluded, false); } catch (Exception) { }
                }
            });
            watcher.IsBackground = true;
            watcher.Start();
        }
        else
        {
            return 2;
        }

        // Whoever started this closes its standard input to end it, or dies and closes it anyway.
        var input = new Thread(delegate ()
        {
            try
            {
                Stream stream = Console.OpenStandardInput();
                var scratch = new byte[64];
                while (stream.Read(scratch, 0, scratch.Length) > 0) { }
            }
            catch (IOException) { }
            Environment.Exit(0);
        });
        input.IsBackground = true;
        input.Start();

        return Mix(target);
    }

    // Writes the sum of the sources at the device's pace, 10 ms at a time.
    static int Mix(uint single)
    {
        Stream output = Console.OpenStandardOutput();
        Process process = null;
        if (single != 0) { try { process = Process.GetProcessById((int)single); } catch (Exception) { } }
        var clock = Stopwatch.StartNew();
        long written = 0;
        var mix = new int[SampleRate / 10 * Channels];
        var bytes = new byte[mix.Length * 2];
        long checkedAt = 0;
        try
        {
            while (true)
            {
                Thread.Sleep(5);
                long due = clock.ElapsedTicks * SampleRate / Stopwatch.Frequency - written;
                // After a long stall the gap is not made up: that sound is gone anyway.
                if (due > SampleRate / 10) { written += due - SampleRate / 100; due = SampleRate / 100; }
                if (due < SampleRate / 100) continue;
                int count = (int)due;
                Array.Clear(mix, 0, count * Channels);
                Source[] current;
                lock (sources) current = sources.ToArray();
                foreach (Source source in current) source.MixInto(mix, count);
                for (int i = 0; i < count * Channels; i++)
                {
                    int sample = Math.Max(-32768, Math.Min(32767, mix[i]));
                    bytes[i * 2] = (byte)sample;
                    bytes[i * 2 + 1] = (byte)(sample >> 8);
                }
                output.Write(bytes, 0, count * BytesPerFrame);
                output.Flush();
                written += count;
                if (process != null && clock.ElapsedMilliseconds - checkedAt > 1000)
                {
                    checkedAt = clock.ElapsedMilliseconds;
                    try { if (process.HasExited) return 0; } catch (Exception) { }
                }
            }
        }
        catch (IOException)
        {
            return 0;
        }
    }

    // Starts capturing one process tree on a thread of its own.
    static void StartSource(uint processId)
    {
        IAudioClient client = Activate(processId);
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
        if (result < 0) throw new COMException("Initialize", result);
        Guid captureId = typeof(IAudioCaptureClient).GUID;
        object service;
        result = client.GetService(ref captureId, out service);
        if (result < 0) throw new COMException("GetService", result);
        var capture = (IAudioCaptureClient)service;
        result = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        if (result < 0) throw new COMException("SetEventHandle", result);
        result = client.Start();
        if (result < 0) throw new COMException("Start", result);

        var source = new Source(processId);
        lock (sources) sources.Add(source);
        var thread = new Thread(delegate ()
        {
            GC.KeepAlive(client);
            while (true)
            {
                if (!ready.WaitOne(1000)) continue;
                uint frames;
                while (capture.GetNextPacketSize(out frames) >= 0 && frames > 0)
                {
                    IntPtr data;
                    uint flags;
                    ulong devicePosition, counterPosition;
                    if (capture.GetBuffer(out data, out frames, out flags, out devicePosition, out counterPosition) < 0) break;
                    var piece = new short[frames * Channels];
                    // AUDCLNT_BUFFERFLAGS_SILENT: the bytes are to be taken as silence.
                    if ((flags & 2) == 0) Marshal.Copy(data, piece, 0, piece.Length);
                    capture.ReleaseBuffer(frames);
                    source.Push(piece);
                }
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    // Everything that plays sound on the default output, except voice chats and `excluded`.
    // A capture takes a whole process tree, so a program is left out when a voice chat descends
    // from it (the shell starts everything), and when an ancestor is captured already (a game
    // started by its launcher would be heard twice).
    static void AddPlaying(HashSet<uint> excluded, bool first)
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        // eRender, eConsole
        if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0) throw new InvalidOperationException("no output device");
        Guid managerId = typeof(IAudioSessionManager2).GUID;
        object activated;
        // CLSCTX_ALL
        if (device.Activate(ref managerId, 23, IntPtr.Zero, out activated) < 0) throw new InvalidOperationException("no session manager");
        IAudioSessionEnumerator sessions;
        if (((IAudioSessionManager2)activated).GetSessionEnumerator(out sessions) < 0) throw new InvalidOperationException("no sessions");
        int count;
        sessions.GetCount(out count);
        var playing = new HashSet<uint>();
        for (int i = 0; i < count; i++)
        {
            object session;
            if (sessions.GetSession(i, out session) < 0) continue;
            var control = session as IAudioSessionControl2;
            uint processId;
            if (control != null && control.GetProcessId(out processId) >= 0 && processId != 0) playing.Add(processId);
        }

        var parents = new Dictionary<uint, uint>();
        var names = new Dictionary<uint, string>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
        var entry = new ProcessEntry();
        entry.Size = Marshal.SizeOf(typeof(ProcessEntry));
        if (Process32FirstW(snapshot, ref entry))
        {
            do
            {
                parents[entry.ProcessId] = entry.ParentProcessId;
                names[entry.ProcessId] = Path.GetFileNameWithoutExtension(entry.ExeFile).ToLowerInvariant();
            } while (Process32NextW(snapshot, ref entry));
        }
        CloseHandle(snapshot);

        var forbidden = new HashSet<uint>(excluded);
        foreach (KeyValuePair<uint, string> process in names)
        {
            if (Array.IndexOf(VoiceChats, process.Value) >= 0) forbidden.Add(process.Key);
        }
        var taken = new HashSet<uint>();
        lock (sources) foreach (Source source in sources) taken.Add(source.ProcessId);
        var unsafeRoots = new HashSet<uint>();
        foreach (uint id in forbidden) foreach (uint ancestor in Ancestors(id, parents)) unsafeRoots.Add(ancestor);

        var chosen = new List<uint>();
        foreach (uint id in playing)
        {
            if (taken.Contains(id) || forbidden.Contains(id) || unsafeRoots.Contains(id)) continue;
            bool covered = false;
            foreach (uint ancestor in Ancestors(id, parents))
            {
                if ((playing.Contains(ancestor) && !forbidden.Contains(ancestor) && !unsafeRoots.Contains(ancestor)) || taken.Contains(ancestor)) { covered = true; break; }
            }
            if (!covered) chosen.Add(id);
        }
        Exception failure = null;
        int started = 0;
        foreach (uint id in chosen)
        {
            try { StartSource(id); started++; } catch (Exception error) { failure = error; }
        }
        if (first && started == 0 && failure != null) throw failure;
    }

    static IEnumerable<uint> Ancestors(uint id, Dictionary<uint, uint> parents)
    {
        var seen = new HashSet<uint>();
        uint current = id;
        uint parent;
        while (parents.TryGetValue(current, out parent) && parent != 0 && seen.Add(parent) && seen.Count < 64)
        {
            yield return parent;
            current = parent;
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

    // The monitors as the screen capture (Desktop Duplication) numbers them: by graphics card,
    // then by output of that card, with where each one sits on the desktop, in real pixels.
    static int Monitors()
    {
        Guid factoryId = typeof(IDXGIFactory1).GUID;
        IDXGIFactory1 factory;
        if (CreateDXGIFactory1(ref factoryId, out factory) < 0) return 3;
        var listed = new List<string>();
        for (uint adapterIndex = 0; ; adapterIndex++)
        {
            IDXGIAdapter adapter;
            if (factory.EnumAdapters(adapterIndex, out adapter) < 0) break;
            for (uint outputIndex = 0; ; outputIndex++)
            {
                IDXGIOutput output;
                if (adapter.EnumOutputs(outputIndex, out output) < 0) break;
                OutputDescription description;
                if (output.GetDesc(out description) < 0 || description.Attached == 0) continue;
                Rect desktop = description.Desktop;
                listed.Add("{\"adapter\":" + adapterIndex + ",\"output\":" + outputIndex
                    + ",\"x\":" + desktop.Left + ",\"y\":" + desktop.Top
                    + ",\"width\":" + (desktop.Right - desktop.Left)
                    + ",\"height\":" + (desktop.Bottom - desktop.Top) + "}");
            }
        }
        Console.Out.WriteLine("[" + string.Join(",", listed.ToArray()) + "]");
        return 0;
    }

    static int Describe(IntPtr window)
    {
        Rect rect;
        if (!GetWindowRect(window, out rect)) return 2;
        var info = new MonitorInfo();
        info.Size = Marshal.SizeOf(typeof(MonitorInfo));
        // MONITOR_DEFAULTTONEAREST
        if (!GetMonitorInfo(MonitorFromRect(ref rect, 2), ref info)) return 2;
        Rect monitor = info.Monitor;
        bool covers = !IsIconic(window) && rect.Left <= monitor.Left && rect.Top <= monitor.Top
            && rect.Right >= monitor.Right && rect.Bottom >= monitor.Bottom;
        Console.Out.WriteLine("{\"covers\":" + (covers ? "true" : "false")
            + ",\"monitor\":{\"x\":" + monitor.Left + ",\"y\":" + monitor.Top
            + ",\"width\":" + (monitor.Right - monitor.Left)
            + ",\"height\":" + (monitor.Bottom - monitor.Top) + "}}");
        return 0;
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
