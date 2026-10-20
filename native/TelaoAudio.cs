// telao-audio.exe: captura o som de aplicativos específicos no Windows 10 2004+ / 11,
// usando a API de "process loopback" do WASAPI (a mesma técnica do OBS e do Discord).
//
// Modos:
//   --mode all  : som de todos os apps que estão tocando, EXCETO os excluídos
//                 (por nome do .exe e/ou PID, incluindo os processos filhos deles).
//   --mode app  : som só do app dono da janela (--hwnd) ou do processo (--pid).
//   --mode list : lista os apps com sessão de áudio (JSON) e sai.
//
// Saída (stdout), pacotes binários: [tipo u8][id u32][tamanho u32][dados]
//   tipo 1 = áudio PCM 16 bits, estéreo, 48 kHz, do app "id"
//   tipo 2 = evento JSON (UTF-8)
// Encerra quando o stdin é fechado (o Telão saiu) ou quando é finalizado.
//
// Compilado com o csc.exe do .NET Framework 4 que já vem no Windows (C# 5).

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TelaoAudio
{
    // ---------------- Interop COM / Win32 ----------------

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceAsyncOperation
    {
        void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IActivateAudioInterfaceCompletionHandler
    {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    // Marcador: o callback de ativação precisa ser um objeto "agile".
    [ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAgileObject { }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        void Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, [In] WaveFormatEx format, IntPtr sessionGuid);
        void GetBufferSize(out uint frames);
        void GetStreamLatency(out long latency);
        void GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, [In] WaveFormatEx format, IntPtr closestMatch);
        void GetMixFormat(out IntPtr format);
        void GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        void Start();
        void Stop();
        void Reset();
        void SetEventHandle(IntPtr eventHandle);
        void GetService([MarshalAs(UnmanagedType.LPStruct)] Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorCom { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        void EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
        void GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
        void GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        void RegisterEndpointNotificationCallback(IntPtr client);
        void UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        void GetCount(out uint count);
        void Item(uint index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        void Activate([MarshalAs(UnmanagedType.LPStruct)] Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        void OpenPropertyStore(int access, out IntPtr properties);
        void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        void GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        void GetAudioSessionControl(IntPtr sessionGuid, int streamFlags, out IntPtr control);
        void GetSimpleAudioVolume(IntPtr sessionGuid, int streamFlags, out IntPtr volume);
        void GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        void RegisterSessionNotification(IntPtr notification);
        void UnregisterSessionNotification(IntPtr notification);
        void RegisterDuckNotification(IntPtr sessionId, IntPtr notification);
        void UnregisterDuckNotification(IntPtr notification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        void GetCount(out int count);
        void GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object session);
    }

    // IAudioSessionControl2 (os métodos de IAudioSessionControl vêm primeiro, na ordem da vtable).
    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        void GetState(out int state);
        void GetDisplayName(out IntPtr name);
        void SetDisplayName(IntPtr name, IntPtr eventContext);
        void GetIconPath(out IntPtr path);
        void SetIconPath(IntPtr path, IntPtr eventContext);
        void GetGroupingParam(out Guid groupingParam);
        void SetGroupingParam(IntPtr groupingParam, IntPtr eventContext);
        void RegisterAudioSessionNotification(IntPtr notification);
        void UnregisterAudioSessionNotification(IntPtr notification);
        void GetSessionIdentifier(out IntPtr id);
        void GetSessionInstanceIdentifier(out IntPtr id);
        void GetProcessId(out uint pid);
        [PreserveSig] int IsSystemSoundsSession();
        void SetDuckingPreference(bool optOut);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    class WaveFormatEx
    {
        public ushort FormatTag;
        public ushort Channels;
        public uint SamplesPerSec;
        public uint AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort Size;

        public WaveFormatEx(uint rate, ushort bits, ushort channels)
        {
            FormatTag = 1; // PCM
            Channels = channels;
            SamplesPerSec = rate;
            BitsPerSample = bits;
            BlockAlign = (ushort)(channels * bits / 8);
            AvgBytesPerSec = rate * BlockAlign;
            Size = 0;
        }
    }

    static class Native
    {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        public static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            IntPtr activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation operation);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct PROCESSENTRY32W
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct OSVERSIONINFOW
        {
            public uint dwOSVersionInfoSize;
            public uint dwMajorVersion;
            public uint dwMinorVersion;
            public uint dwBuildNumber;
            public uint dwPlatformId;
            [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)]
            public byte[] szCSDVersion;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        public static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

        [DllImport("kernel32.dll")]
        public static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

        [DllImport("kernel32.dll")]
        public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

        [DllImport("kernel32.dll")]
        public static extern bool CloseHandle(IntPtr handle);

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

        [DllImport("ntdll.dll")]
        public static extern int RtlGetVersion(ref OSVERSIONINFOW info);
    }

    class CompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        public int Result;
        public object Client;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            try
            {
                int hr;
                object client;
                operation.GetActivateResult(out hr, out client);
                Result = hr;
                Client = client;
            }
            catch (Exception ex)
            {
                Result = Marshal.GetHRForException(ex);
            }
            Done.Set();
        }
    }

    // ---------------- Saída ----------------

    static class Output
    {
        static readonly object Gate = new object();
        static readonly Stream Stdout = Console.OpenStandardOutput();

        public static void Send(byte type, uint id, byte[] payload)
        {
            var header = new byte[9];
            header[0] = type;
            BitConverter.GetBytes(id).CopyTo(header, 1);
            BitConverter.GetBytes((uint)payload.Length).CopyTo(header, 5);
            lock (Gate)
            {
                try
                {
                    Stdout.Write(header, 0, header.Length);
                    Stdout.Write(payload, 0, payload.Length);
                    Stdout.Flush();
                }
                catch (IOException)
                {
                    Environment.Exit(0); // o Telão fechou o pipe
                }
            }
        }

        public static void Event(string json)
        {
            Send(2, 0, Encoding.UTF8.GetBytes(json));
        }

        public static string Q(string value)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in value ?? "")
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.AppendFormat("\\u{0:x4}", (int)c);
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }

    // ---------------- Processos ----------------

    class ProcInfo
    {
        public uint Pid;
        public uint Parent;
        public string Name;
        public long Created;
    }

    static class Processes
    {
        static readonly Dictionary<uint, KeyValuePair<string, long>> CreatedCache = new Dictionary<uint, KeyValuePair<string, long>>();

        public static Dictionary<uint, ProcInfo> Snapshot()
        {
            var map = new Dictionary<uint, ProcInfo>();
            IntPtr snap = Native.CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return map;
            try
            {
                var entry = new Native.PROCESSENTRY32W();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32W));
                if (!Native.Process32FirstW(snap, ref entry)) return map;
                do
                {
                    string name = entry.szExeFile ?? "";
                    map[entry.th32ProcessID] = new ProcInfo
                    {
                        Pid = entry.th32ProcessID,
                        Parent = entry.th32ParentProcessID,
                        Name = name,
                        Created = CreationTime(entry.th32ProcessID, name),
                    };
                } while (Native.Process32NextW(snap, ref entry));
            }
            finally
            {
                Native.CloseHandle(snap);
            }
            return map;
        }

        static long CreationTime(uint pid, string name)
        {
            KeyValuePair<string, long> cached;
            if (CreatedCache.TryGetValue(pid, out cached) && cached.Key == name) return cached.Value;
            long created = 0;
            IntPtr handle = Native.OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (handle != IntPtr.Zero)
            {
                long exit, kernel, user;
                if (!Native.GetProcessTimes(handle, out created, out exit, out kernel, out user)) created = 0;
                Native.CloseHandle(handle);
            }
            CreatedCache[pid] = new KeyValuePair<string, long>(name, created);
            return created;
        }

        // O próprio processo seguido dos ancestrais. Para quando o "pai" é mais
        // novo que o filho (PID reaproveitado depois que o pai original morreu).
        public static List<uint> Chain(Dictionary<uint, ProcInfo> map, uint pid)
        {
            var chain = new List<uint>();
            uint current = pid;
            for (int depth = 0; depth < 64; depth++)
            {
                ProcInfo info;
                if (!map.TryGetValue(current, out info)) break;
                chain.Add(current);
                ProcInfo parent;
                if (info.Parent == 0 || info.Parent == current || !map.TryGetValue(info.Parent, out parent)) break;
                if (parent.Created != 0 && info.Created != 0 && parent.Created > info.Created) break;
                if (chain.Contains(info.Parent)) break;
                current = info.Parent;
            }
            return chain;
        }
    }

    // ---------------- Captura de um app (árvore de processos) ----------------

    class Capture
    {
        const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
        const int AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000;
        const int AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
        const int AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = unchecked((int)0x80000000);
        const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
        static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

        public readonly uint Id;
        public readonly uint Pid;
        public readonly string Name;
        public readonly long Created;
        volatile bool running = true;

        public Capture(uint id, ProcInfo info)
        {
            Id = id;
            Pid = info.Pid;
            Name = info.Name;
            Created = info.Created;
        }

        public void Start()
        {
            var thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Start();
        }

        public void Stop()
        {
            running = false;
        }

        static IAudioClient Activate(uint pid)
        {
            IntPtr parameters = Marshal.AllocHGlobal(12);
            IntPtr propvariant = Marshal.AllocHGlobal(24);
            bool canFree = true;
            try
            {
                Marshal.WriteInt32(parameters, 0, 1);         // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
                Marshal.WriteInt32(parameters, 4, (int)pid);  // TargetProcessId
                Marshal.WriteInt32(parameters, 8, 0);         // PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                for (int i = 0; i < 24; i++) Marshal.WriteByte(propvariant, i, 0);
                Marshal.WriteInt16(propvariant, 0, 65);       // VT_BLOB
                Marshal.WriteInt32(propvariant, 8, 12);       // blob.cbSize
                Marshal.WriteIntPtr(propvariant, 16, parameters); // blob.pBlobData (x64)

                var handler = new CompletionHandler();
                IActivateAudioInterfaceAsyncOperation operation;
                Native.ActivateAudioInterfaceAsync("VAD\\Process_Loopback", IID_IAudioClient, propvariant, handler, out operation);
                if (!handler.Done.WaitOne(5000))
                {
                    canFree = false; // a ativação ainda pode ler os parâmetros
                    throw new TimeoutException("a ativação do áudio demorou demais");
                }
                GC.KeepAlive(operation);
                if (handler.Result != 0) Marshal.ThrowExceptionForHR(handler.Result);
                return (IAudioClient)handler.Client;
            }
            finally
            {
                if (canFree)
                {
                    Marshal.FreeHGlobal(parameters);
                    Marshal.FreeHGlobal(propvariant);
                }
            }
        }

        void Run()
        {
            IAudioClient client = null;
            bool announced = false;
            try
            {
                client = Activate(Pid);
                client.Initialize(0,
                    AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                    200000, 0, new WaveFormatEx(48000, 16, 2), IntPtr.Zero);
                var ready = new AutoResetEvent(false);
                client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
                object service;
                client.GetService(IID_IAudioCaptureClient, out service);
                var capture = (IAudioCaptureClient)service;
                client.Start();
                Output.Event("{\"event\":\"source\",\"id\":" + Id + ",\"pid\":" + Pid + ",\"name\":" + Output.Q(Name) + "}");
                announced = true;

                while (running)
                {
                    ready.WaitOne(50);
                    uint frames;
                    while (running && capture.GetNextPacketSize(out frames) == 0 && frames > 0)
                    {
                        IntPtr data;
                        uint got, flags;
                        ulong devicePosition, qpcPosition;
                        if (capture.GetBuffer(out data, out got, out flags, out devicePosition, out qpcPosition) != 0) break;
                        var bytes = new byte[got * 4];
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && got > 0) Marshal.Copy(data, bytes, 0, bytes.Length);
                        capture.ReleaseBuffer(got);
                        if (got > 0) Output.Send(1, Id, bytes);
                    }
                }
                client.Stop();
                GC.KeepAlive(ready);
            }
            catch (Exception ex)
            {
                Output.Event("{\"event\":\"warning\",\"message\":" + Output.Q("Não foi possível capturar o som de " + Name + ": " + ex.Message) + "}");
            }
            finally
            {
                if (announced) Output.Event("{\"event\":\"source-end\",\"id\":" + Id + "}");
                if (client != null) Marshal.ReleaseComObject(client);
            }
        }
    }

    // ---------------- Programa ----------------

    static class Program
    {
        static readonly Guid IID_IAudioSessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        static readonly HashSet<string> ExcludeNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        static readonly HashSet<uint> ExcludePids = new HashSet<uint>();
        static readonly Dictionary<uint, Capture> Active = new Dictionary<uint, Capture>();
        static readonly HashSet<uint> Reported = new HashSet<uint>();
        static uint nextId = 1;

        [MTAThread]
        static int Main(string[] args)
        {
            string mode = "all";
            uint hwnd = 0, targetPid = 0;
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                string key = args[i], value = args[i + 1];
                if (key == "--mode") mode = value;
                else if (key == "--hwnd") uint.TryParse(value, out hwnd);
                else if (key == "--pid") uint.TryParse(value, out targetPid);
                else if (key == "--exclude-names")
                {
                    foreach (var name in value.Split(new[] { ',', ';', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                        if (name.Trim().Length > 0) ExcludeNames.Add(name.Trim());
                }
                else if (key == "--exclude-pids")
                {
                    foreach (var part in value.Split(','))
                    {
                        uint pid;
                        if (uint.TryParse(part.Trim(), out pid)) ExcludePids.Add(pid);
                    }
                }
            }

            if (mode == "list")
            {
                ListSessions();
                return 0;
            }

            // A própria captura aparece como sessão de áudio deste processo: nunca capturar a si mesmo.
            ExcludePids.Add((uint)System.Diagnostics.Process.GetCurrentProcess().Id);

            var version = new Native.OSVERSIONINFOW();
            version.dwOSVersionInfoSize = (uint)Marshal.SizeOf(typeof(Native.OSVERSIONINFOW));
            Native.RtlGetVersion(ref version);
            if (version.dwMajorVersion < 10 || version.dwBuildNumber < 19041)
            {
                Output.Event("{\"event\":\"error\",\"fatal\":true,\"message\":\"A captura de som por aplicativo exige Windows 10 (versão 2004) ou mais novo.\"}");
                return 2;
            }

            // Sai quando o Telão fecha o stdin (ou morre).
            var watcher = new Thread(delegate ()
            {
                try
                {
                    var input = Console.OpenStandardInput();
                    var buffer = new byte[64];
                    while (input.Read(buffer, 0, buffer.Length) > 0) { }
                }
                catch (Exception) { }
                Environment.Exit(0);
            });
            watcher.IsBackground = true;
            watcher.Start();

            if (mode == "app" && hwnd != 0)
            {
                Native.GetWindowThreadProcessId(new IntPtr(hwnd), out targetPid);
                if (targetPid == 0)
                {
                    Output.Event("{\"event\":\"warning\",\"message\":\"Não foi possível identificar o app da janela; capturando todos os apps permitidos.\"}");
                    mode = "all";
                }
            }

            Output.Event("{\"event\":\"ready\",\"mode\":" + Output.Q(mode) + ",\"build\":" + version.dwBuildNumber + "}");
            while (true)
            {
                try
                {
                    if (mode == "app") RefreshApp(ref mode, targetPid);
                    else RefreshAll();
                }
                catch (Exception ex)
                {
                    Output.Event("{\"event\":\"warning\",\"message\":" + Output.Q("Falha ao listar os apps com som: " + ex.Message) + "}");
                }
                Thread.Sleep(1000);
            }
        }

        static bool IsExcludedItself(ProcInfo info)
        {
            return ExcludeNames.Contains(info.Name) || ExcludePids.Contains(info.Pid);
        }

        // Processos cuja árvore contém algum excluído (incluí-los capturaria o excluído junto).
        static HashSet<uint> Tainted(Dictionary<uint, ProcInfo> map)
        {
            var tainted = new HashSet<uint>();
            foreach (var info in map.Values)
            {
                if (!IsExcludedItself(info)) continue;
                foreach (var pid in Processes.Chain(map, info.Pid)) tainted.Add(pid);
            }
            return tainted;
        }

        static bool InsideExcluded(Dictionary<uint, ProcInfo> map, uint pid, out ProcInfo culprit)
        {
            foreach (var p in Processes.Chain(map, pid))
            {
                if (IsExcludedItself(map[p]))
                {
                    culprit = map[p];
                    return true;
                }
            }
            culprit = null;
            return false;
        }

        static void ReportExcluded(ProcInfo info, string reason)
        {
            if (!Reported.Add(info.Pid)) return;
            Output.Event("{\"event\":\"excluded\",\"pid\":" + info.Pid + ",\"name\":" + Output.Q(info.Name) + ",\"reason\":" + Output.Q(reason) + "}");
        }

        static void RefreshAll()
        {
            var map = Processes.Snapshot();
            var tainted = Tainted(map);
            var candidates = new HashSet<uint>();
            foreach (var pid in SessionPids())
            {
                ProcInfo info;
                if (!map.TryGetValue(pid, out info)) continue;
                ProcInfo culprit;
                if (InsideExcluded(map, pid, out culprit))
                {
                    // Só avisa o que saiu por causa da lista de nomes (ex.: Discord);
                    // o próprio Telão (excluído por PID, para não dar eco) não interessa ao usuário.
                    if (ExcludeNames.Contains(culprit.Name)) ReportExcluded(info, culprit == info ? "lista" : "filho de " + culprit.Name);
                    continue;
                }
                if (tainted.Contains(pid)) continue; // a árvore dele contém um excluído
                candidates.Add(pid);
            }
            // Um app capturado já inclui os processos filhos: não captura o filho de novo.
            var roots = new HashSet<uint>(candidates.Where(pid => !Processes.Chain(map, pid).Skip(1).Any(candidates.Contains)));
            Sync(map, roots);
        }

        static void RefreshApp(ref string mode, uint pid)
        {
            var map = Processes.Snapshot();
            ProcInfo info;
            if (!map.TryGetValue(pid, out info))
            {
                Sync(map, new HashSet<uint>());
                return;
            }
            ProcInfo culprit;
            if (InsideExcluded(map, pid, out culprit))
            {
                if (ExcludeNames.Contains(culprit.Name)) ReportExcluded(info, "lista");
                Sync(map, new HashSet<uint>());
                return;
            }
            if (Tainted(map).Contains(pid))
            {
                Output.Event("{\"event\":\"warning\",\"message\":" + Output.Q(info.Name + " abre apps excluídos; capturando todos os apps permitidos.") + "}");
                mode = "all";
                RefreshAll();
                return;
            }
            Sync(map, new HashSet<uint> { pid });
        }

        static void Sync(Dictionary<uint, ProcInfo> map, HashSet<uint> wanted)
        {
            foreach (var pid in Active.Keys.ToList())
            {
                var capture = Active[pid];
                ProcInfo info;
                bool alive = map.TryGetValue(pid, out info) && info.Created == capture.Created;
                if (!alive || !wanted.Contains(pid))
                {
                    capture.Stop();
                    Active.Remove(pid);
                }
            }
            foreach (var pid in wanted)
            {
                if (Active.ContainsKey(pid)) continue;
                var capture = new Capture(nextId++, map[pid]);
                Active[pid] = capture;
                capture.Start();
            }
        }

        static IEnumerable<IAudioSessionControl2> Sessions()
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
            IMMDeviceCollection devices;
            enumerator.EnumAudioEndpoints(0, 1, out devices); // eRender, DEVICE_STATE_ACTIVE
            uint count;
            devices.GetCount(out count);
            var result = new List<IAudioSessionControl2>();
            for (uint i = 0; i < count; i++)
            {
                IMMDevice device;
                devices.Item(i, out device);
                object managerObject;
                device.Activate(IID_IAudioSessionManager2, 23, IntPtr.Zero, out managerObject);
                var manager = (IAudioSessionManager2)managerObject;
                IAudioSessionEnumerator sessions;
                manager.GetSessionEnumerator(out sessions);
                int total;
                sessions.GetCount(out total);
                for (int j = 0; j < total; j++)
                {
                    object session;
                    sessions.GetSession(j, out session);
                    var control = session as IAudioSessionControl2;
                    if (control != null) result.Add(control);
                }
                Marshal.ReleaseComObject(sessions);
                Marshal.ReleaseComObject(manager);
                Marshal.ReleaseComObject(device);
            }
            Marshal.ReleaseComObject(devices);
            Marshal.ReleaseComObject(enumerator);
            return result;
        }

        static HashSet<uint> SessionPids()
        {
            var pids = new HashSet<uint>();
            foreach (var control in Sessions())
            {
                try
                {
                    int state;
                    control.GetState(out state);
                    uint pid;
                    control.GetProcessId(out pid);
                    if (state != 2 && pid != 0 && control.IsSystemSoundsSession() != 0) pids.Add(pid); // 2 = expirada
                }
                catch (Exception) { }
                Marshal.ReleaseComObject(control);
            }
            return pids;
        }

        static void ListSessions()
        {
            var map = Processes.Snapshot();
            var items = new List<string>();
            foreach (var pid in SessionPids())
            {
                ProcInfo info;
                if (!map.TryGetValue(pid, out info)) continue;
                items.Add("{\"pid\":" + pid + ",\"name\":" + Output.Q(info.Name) + "}");
            }
            var json = Encoding.UTF8.GetBytes("[" + string.Join(",", items) + "]\n");
            var stdout = Console.OpenStandardOutput();
            stdout.Write(json, 0, json.Length);
            stdout.Flush();
        }
    }
}
