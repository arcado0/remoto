using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Remoto.Service;

/// <summary>
/// Helper di sessione. Avviato dal servizio come SYSTEM nella sessione dell'utente, riceve da Remoto
/// (solo Remoto.exe installato in Programmi, nella stessa sessione) l'input da iniettare sul desktop
/// attivo — anche quello protetto di UAC e della schermata di blocco — e cattura quel desktop, che
/// Chromium non vede. Avviato a mano da un utente normale funziona in "modalità di prova", senza
/// privilegi in più (e quindi senza restrizioni sul client).
/// </summary>
internal sealed class Helper
{
    private readonly uint session;
    private readonly bool isSystem;
    private readonly string pipeName;
    private readonly BlockingCollection<Native.INPUT[]> inputQueue = new(new ConcurrentQueue<Native.INPUT[]>(), 4096);
    private readonly BlockingCollection<Action> captureQueue = new(new ConcurrentQueue<Action>(), 8);
    private readonly DesktopBinder captureDesktop = new();
    private volatile Frames? client;
    private volatile string desktopName = "";
    private long lastInputError;

    public Helper(uint session)
    {
        this.session = session;
        isSystem = Program.IsSystem();
        pipeName = $"remoto-input-{session}";
    }

    public int Run()
    {
        Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); // per monitor v2
        Log.Write($"helper nella sessione {session} ({(isSystem ? "SYSTEM" : "utente: modalità di prova")}), INPUT = {Marshal.SizeOf<Native.INPUT>()} byte");
        Start(InputLoop, "input");
        Start(CaptureLoop, "cattura");
        Start(DesktopWatch, "desktop");
        while (true)
        {
            NamedPipeServerStream pipe;
            try
            {
                pipe = CreatePipe();
            }
            catch (Exception e)
            {
                Log.Write($"creazione della pipe non riuscita: {e.Message}");
                Thread.Sleep(2000);
                continue;
            }
            using (pipe)
            {
                try
                {
                    pipe.WaitForConnection();
                }
                catch (IOException e)
                {
                    Log.Write($"pipe: {e.Message}");
                    continue;
                }
                if (!Authorize(pipe, out var why))
                {
                    Log.Write($"connessione rifiutata: {why}");
                    continue;
                }
                Serve(pipe);
            }
        }
    }

    private static void Start(ThreadStart body, string name) => new Thread(body) { IsBackground = true, Name = name }.Start();

    private NamedPipeServerStream CreatePipe()
    {
        var security = new PipeSecurity();
        if (isSystem)
        {
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.InteractiveSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
        }
        else
        {
            using var me = WindowsIdentity.GetCurrent();
            security.AddAccessRule(new PipeAccessRule(me.User!, PipeAccessRights.FullControl, AccessControlType.Allow));
        }
        // Asynchronous: senza overlapped I/O la scrittura (cattura/desktop su altri thread) resta bloccata finché il thread Serve è fermo in Read.
        return NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1 << 16, 1 << 20, security);
    }

    /// <summary>Solo Remoto.exe installato in Programmi (cartella non modificabile dagli utenti) e nella stessa sessione.</summary>
    private bool Authorize(NamedPipeServerStream pipe, out string why)
    {
        why = "";
        if (!Native.GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out var pid))
        {
            why = "processo sconosciuto";
            return false;
        }
        if (!Native.ProcessIdToSessionId(pid, out var s) || s != session)
        {
            why = $"il client è in un'altra sessione ({s})";
            return false;
        }
        if (!isSystem) return true;
        var path = ProcessPath(pid);
        if (path is null)
        {
            why = "percorso del client sconosciuto";
            return false;
        }
        if (!string.Equals(Path.GetFileName(path), "Remoto.exe", StringComparison.OrdinalIgnoreCase))
        {
            why = $"client non autorizzato: {path}";
            return false;
        }
        if (!IsProtectedLocation(path))
        {
            why = $"Remoto.exe non è nella cartella Programmi: {path}";
            return false;
        }
        return true;
    }

    public static bool IsProtectedLocation(string path)
    {
        var full = Path.GetFullPath(path);
        foreach (var root in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            if (!string.IsNullOrEmpty(root) && full.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static string? ProcessPath(uint pid)
    {
        var h = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            uint size = (uint)sb.Capacity;
            return Native.QueryFullProcessImageNameW(h, 0, sb, ref size) ? sb.ToString() : null;
        }
        finally
        {
            Native.CloseHandle(h);
        }
    }

    private void Serve(NamedPipeServerStream pipe)
    {
        var frames = new Frames(pipe);
        client = frames;
        Log.Write("Remoto collegato");
        try
        {
            while (pipe.IsConnected)
            {
                var msg = frames.Read();
                if (msg is null) break;
                if (msg.Value.Type == Frames.Json) Handle(frames, msg.Value.Data);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidDataException or JsonException or InvalidOperationException or KeyNotFoundException)
        {
            Log.Write($"connessione chiusa: {e.Message}");
        }
        finally
        {
            client = null;
        }
    }

    private void Handle(Frames frames, byte[] data)
    {
        using var doc = JsonDocument.Parse(data);
        var root = doc.RootElement;
        var op = root.TryGetProperty("op", out var opEl) ? opEl.GetString() ?? "" : "";
        long id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number ? idEl.GetInt64() : 0;
        switch (op)
        {
            case "hello":
                frames.SendJson(w =>
                {
                    w.WriteNumber("id", id);
                    w.WriteBoolean("ok", true);
                    w.WriteNumber("v", 1);
                    w.WriteNumber("session", session);
                    w.WriteBoolean("system", isSystem);
                    w.WriteString("desktop", desktopName);
                });
                break;
            case "input":
                EnqueueInput(root.GetProperty("events"));
                break;
            case "sas":
                {
                    var (ok, error) = RequestSas();
                    frames.SendJson(w =>
                    {
                        w.WriteNumber("id", id);
                        w.WriteBoolean("ok", ok);
                        if (error is not null) w.WriteString("error", error);
                    });
                    break;
                }
            case "capture":
                {
                    int maxWidth = root.TryGetProperty("maxWidth", out var mw) && mw.ValueKind == JsonValueKind.Number ? mw.GetInt32() : 1600;
                    if (!captureQueue.TryAdd(() => CaptureAndSend(frames, id, maxWidth)))
                        frames.SendJson(w => { w.WriteNumber("id", id); w.WriteBoolean("ok", false); w.WriteString("error", "cattura occupata"); });
                    break;
                }
            case "desktop":
                frames.SendJson(w => { w.WriteNumber("id", id); w.WriteBoolean("ok", true); w.WriteString("desktop", desktopName); });
                break;
            default:
                frames.SendJson(w => { w.WriteNumber("id", id); w.WriteBoolean("ok", false); w.WriteString("error", "operazione sconosciuta"); });
                break;
        }
    }

    // ---------- input ----------

    /// <summary>Eventi ["m", dx, dy, mouseData, flags] e ["k", vk, scan, flags]: gli stessi campi di SendInput.</summary>
    private void EnqueueInput(JsonElement events)
    {
        var list = new List<Native.INPUT>(events.GetArrayLength());
        foreach (var ev in events.EnumerateArray())
        {
            if (ev.ValueKind != JsonValueKind.Array || ev.GetArrayLength() < 4) continue;
            var kind = ev[0].GetString();
            if (kind == "m" && ev.GetArrayLength() >= 5)
            {
                list.Add(new Native.INPUT
                {
                    type = Native.INPUT_MOUSE,
                    u = new Native.InputUnion { mi = new Native.MOUSEINPUT { dx = ev[1].GetInt32(), dy = ev[2].GetInt32(), mouseData = unchecked((uint)ev[3].GetInt64()), dwFlags = (uint)ev[4].GetInt64() } },
                });
            }
            else if (kind == "k")
            {
                list.Add(new Native.INPUT
                {
                    type = Native.INPUT_KEYBOARD,
                    u = new Native.InputUnion { ki = new Native.KEYBDINPUT { wVk = (ushort)ev[1].GetInt32(), wScan = (ushort)ev[2].GetInt32(), dwFlags = (uint)ev[3].GetInt64() } },
                });
            }
        }
        if (list.Count > 0) inputQueue.TryAdd(list.ToArray());
    }

    private void InputLoop()
    {
        var desktop = new DesktopBinder();
        int size = Marshal.SizeOf<Native.INPUT>();
        foreach (var batch in inputQueue.GetConsumingEnumerable())
        {
            desktop.Ensure();
            uint sent = Native.SendInput((uint)batch.Length, batch, size);
            if (sent != batch.Length)
            {
                long now = Environment.TickCount64;
                if (now - lastInputError > 10_000)
                {
                    lastInputError = now;
                    Log.Write($"SendInput: {sent}/{batch.Length} eventi (errore {Marshal.GetLastWin32Error()}) sul desktop {desktop.Name}");
                }
            }
        }
    }

    // ---------- desktop protetto ----------

    private void DesktopWatch()
    {
        while (true)
        {
            string name;
            var h = Native.OpenInputDesktop(0, false, 0x0001); // DESKTOP_READOBJECTS
            if (h != IntPtr.Zero)
            {
                name = DesktopBinder.NameOf(h);
                Native.CloseDesktop(h);
            }
            else
            {
                // un utente normale non può aprire il desktop protetto: vuol dire che è attivo quello
                name = isSystem ? desktopName : "Winlogon";
            }
            if (name != desktopName)
            {
                desktopName = name;
                var c = client;
                try
                {
                    c?.SendJson(w => { w.WriteString("ev", "desktop"); w.WriteString("name", name); });
                }
                catch
                {
                    // client appena scollegato
                }
            }
            Thread.Sleep(250);
        }
    }

    private void CaptureLoop()
    {
        foreach (var job in captureQueue.GetConsumingEnumerable()) job();
    }

    private void CaptureAndSend(Frames frames, long id, int maxWidth)
    {
        try
        {
            Log.Write("cattura: inizio");
            captureDesktop.Ensure();
            Log.Write($"cattura: desktop {captureDesktop.Name}");
            var started = Environment.TickCount64;
            var (w, h, pixels) = Grab(maxWidth);
            Log.Write($"cattura: {w}x{h} in {Environment.TickCount64 - started} ms");
            if (Environment.TickCount64 - started > 1000) Log.Write($"cattura lenta: {Environment.TickCount64 - started} ms");
            frames.SendJson(wr =>
            {
                wr.WriteNumber("id", id);
                wr.WriteBoolean("ok", true);
                wr.WriteNumber("w", w);
                wr.WriteNumber("h", h);
                wr.WriteString("desktop", captureDesktop.Name);
            }, pixels, withBinary: true);
        }
        catch (Exception e)
        {
            Log.Write($"cattura non riuscita: {e}");
            try
            {
                frames.SendJson(wr => { wr.WriteNumber("id", id); wr.WriteBoolean("ok", false); wr.WriteString("error", e.Message); });
            }
            catch
            {
                // client scollegato
            }
        }
    }

    /// <summary>Monitor principale (dove compaiono UAC e la schermata di blocco), ridotto a maxWidth, in BGRA.</summary>
    private static (int W, int H, byte[] Pixels) Grab(int maxWidth)
    {
        int sw = Native.GetSystemMetrics(0);
        int sh = Native.GetSystemMetrics(1);
        if (sw <= 0 || sh <= 0) throw new InvalidOperationException("schermo non disponibile");
        int w = Math.Min(sw, Math.Max(320, maxWidth));
        int h = (int)Math.Round((double)sh * w / sw);
        var screen = Native.GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) throw new InvalidOperationException("GetDC non riuscita");
        var mem = Native.CreateCompatibleDC(screen);
        var header = new Native.BITMAPINFOHEADER { biSize = 40, biWidth = w, biHeight = -h, biPlanes = 1, biBitCount = 32, biCompression = 0 };
        var bitmap = Native.CreateDIBSection(mem, ref header, 0, out var bits, IntPtr.Zero, 0);
        try
        {
            if (bitmap == IntPtr.Zero) throw new InvalidOperationException("CreateDIBSection non riuscita");
            var old = Native.SelectObject(mem, bitmap);
            Native.SetStretchBltMode(mem, Native.HALFTONE);
            Native.SetBrushOrgEx(mem, 0, 0, IntPtr.Zero);
            bool ok = Native.StretchBlt(mem, 0, 0, w, h, screen, 0, 0, sw, sh, Native.SRCCOPY | Native.CAPTUREBLT);
            var pixels = new byte[w * h * 4];
            Marshal.Copy(bits, pixels, 0, pixels.Length);
            Native.SelectObject(mem, old);
            if (!ok) throw new InvalidOperationException("StretchBlt non riuscita");
            for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255; // GDI lascia l'alfa a zero
            return (w, h, pixels);
        }
        finally
        {
            if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
            Native.DeleteDC(mem);
            Native.ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // ---------- Ctrl+Alt+Canc ----------

    private static (bool Ok, string? Error) RequestSas()
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", "remoto-sas", PipeDirection.InOut);
            pipe.Connect(1500);
            pipe.WriteByte(1);
            pipe.Flush();
            return pipe.ReadByte() == 1 ? (true, null) : (false, "il servizio ha rifiutato la richiesta");
        }
        catch (TimeoutException)
        {
            return (false, "servizio di sistema non disponibile");
        }
        catch (Exception e)
        {
            return (false, e.Message);
        }
    }
}

/// <summary>Aggancia il thread corrente al desktop che riceve l'input (Default, Winlogon, Screen-saver).</summary>
internal sealed class DesktopBinder
{
    private IntPtr current;

    public string Name { get; private set; } = "";

    public string Ensure()
    {
        var h = Native.OpenInputDesktop(0, false, Native.DESKTOP_ALL);
        if (h == IntPtr.Zero) return Name;
        var name = NameOf(h);
        if (current != IntPtr.Zero && name == Name)
        {
            Native.CloseDesktop(h);
            return Name;
        }
        if (Native.SetThreadDesktop(h))
        {
            if (current != IntPtr.Zero) Native.CloseDesktop(current);
            current = h;
            Name = name;
        }
        else
        {
            Native.CloseDesktop(h);
        }
        return Name;
    }

    public static string NameOf(IntPtr desktop)
    {
        var sb = new StringBuilder(256);
        return Native.GetUserObjectInformationW(desktop, Native.UOI_NAME, sb, sb.Capacity * 2, out _) ? sb.ToString() : "";
    }
}
