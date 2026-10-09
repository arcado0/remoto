using System.ComponentModel;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Remoto.Service;

/// <summary>Il servizio Windows vero e proprio (account LocalSystem), senza dipendenze esterne.</summary>
internal static class ServiceHost
{
    // i delegati restano in campi statici: il Gestore servizi li richiama da codice nativo
    private static readonly Native.ServiceMainProc MainProc = ServiceMain;
    private static readonly Native.HandlerExProc HandlerProc = Handler;
    private static IntPtr statusHandle;
    private static Native.SERVICE_STATUS status = new() { dwServiceType = Native.SERVICE_WIN32_OWN_PROCESS };
    private static Supervisor? supervisor;

    public static int Run()
    {
        var table = new[]
        {
            new Native.SERVICE_TABLE_ENTRYW { lpServiceName = Program.ServiceName, lpServiceProc = Marshal.GetFunctionPointerForDelegate(MainProc) },
            new Native.SERVICE_TABLE_ENTRYW { lpServiceName = null, lpServiceProc = IntPtr.Zero },
        };
        if (Native.StartServiceCtrlDispatcherW(table)) return 0;
        // 1063: l'eseguibile è stato aperto a mano, non dal Gestore servizi
        return Marshal.GetLastWin32Error() == Native.ERROR_FAILED_SERVICE_CONTROLLER_CONNECT ? 2 : 3;
    }

    private static void ServiceMain(uint argc, IntPtr argv)
    {
        statusHandle = Native.RegisterServiceCtrlHandlerExW(Program.ServiceName, HandlerProc, IntPtr.Zero);
        SetState(Native.SERVICE_START_PENDING, 0);
        supervisor = new Supervisor();
        supervisor.Start();
        SetState(Native.SERVICE_RUNNING, Native.SERVICE_ACCEPT_STOP | Native.SERVICE_ACCEPT_SHUTDOWN | Native.SERVICE_ACCEPT_SESSIONCHANGE);
        Log.Write("servizio avviato");
    }

    private static uint Handler(uint control, uint eventType, IntPtr eventData, IntPtr context)
    {
        switch (control)
        {
            case Native.SERVICE_CONTROL_STOP:
            case Native.SERVICE_CONTROL_SHUTDOWN:
                SetState(Native.SERVICE_STOP_PENDING, 0);
                supervisor?.Stop();
                Log.Write("servizio fermato");
                SetState(Native.SERVICE_STOPPED, 0);
                return 0;
            case Native.SERVICE_CONTROL_SESSIONCHANGE:
                supervisor?.Poke();
                return 0;
            case Native.SERVICE_CONTROL_INTERROGATE:
                return 0;
            default:
                return 120; // ERROR_CALL_NOT_IMPLEMENTED
        }
    }

    private static void SetState(uint state, uint accepted)
    {
        status.dwCurrentState = state;
        status.dwControlsAccepted = accepted;
        status.dwWin32ExitCode = 0;
        status.dwWaitHint = state is Native.SERVICE_RUNNING or Native.SERVICE_STOPPED ? 0u : 10_000u;
        Native.SetServiceStatus(statusHandle, ref status);
    }
}

/// <summary>Tiene un helper vivo nella sessione della console e gestisce Ctrl+Alt+Canc.</summary>
internal sealed class Supervisor
{
    private const uint WAIT_TIMEOUT = 0x102;
    private readonly AutoResetEvent wake = new(false);
    private readonly CancellationTokenSource cancel = new();
    private volatile bool stopping;
    private Thread? loop;
    private IntPtr helperProcess = IntPtr.Zero;
    private uint helperSession = Native.INVALID_SESSION;

    public void Start()
    {
        loop = new Thread(Loop) { IsBackground = true, Name = "supervisore" };
        loop.Start();
        new Thread(SasLoop) { IsBackground = true, Name = "sas" }.Start();
    }

    public void Poke() => wake.Set();

    public void Stop()
    {
        stopping = true;
        cancel.Cancel();
        wake.Set();
        loop?.Join(3000);
        KillHelper();
    }

    private void Loop()
    {
        while (!stopping)
        {
            try
            {
                uint sid = Native.WTSGetActiveConsoleSessionId();
                bool alive = helperProcess != IntPtr.Zero && WaitForSingleObject(helperProcess, 0) == WAIT_TIMEOUT;
                if (sid != Native.INVALID_SESSION && (!alive || sid != helperSession))
                {
                    KillHelper();
                    StartHelper(sid);
                }
            }
            catch (Exception e)
            {
                Log.Write($"supervisore: {e.Message}");
            }
            wake.WaitOne(2000);
        }
    }

    private void StartHelper(uint sid)
    {
        if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out var token)) throw new Win32Exception();
        try
        {
            if (!Native.DuplicateTokenEx(token, 0x02000000 /* MAXIMUM_ALLOWED */, IntPtr.Zero, Native.SecurityImpersonation, Native.TokenPrimary, out var dup)) throw new Win32Exception();
            try
            {
                uint s = sid;
                if (!Native.SetTokenInformation(dup, Native.TokenSessionId, ref s, sizeof(uint))) throw new Win32Exception();
                Native.CreateEnvironmentBlock(out var env, dup, false);
                var exe = Environment.ProcessPath!;
                var si = new Native.STARTUPINFOW { cb = Marshal.SizeOf<Native.STARTUPINFOW>(), lpDesktop = @"winsta0\default" };
                var cmd = new StringBuilder($"\"{exe}\" helper {sid}");
                bool ok = Native.CreateProcessAsUserW(dup, exe, cmd, IntPtr.Zero, IntPtr.Zero, false, Native.CREATE_NO_WINDOW | Native.CREATE_UNICODE_ENVIRONMENT, env, Path.GetDirectoryName(exe), ref si, out var pi);
                int err = Marshal.GetLastWin32Error();
                if (env != IntPtr.Zero) Native.DestroyEnvironmentBlock(env);
                if (!ok) throw new Win32Exception(err);
                Native.CloseHandle(pi.hThread);
                helperProcess = pi.hProcess;
                helperSession = sid;
                Log.Write($"helper avviato nella sessione {sid} (pid {pi.dwProcessId})");
            }
            finally
            {
                Native.CloseHandle(dup);
            }
        }
        finally
        {
            Native.CloseHandle(token);
        }
    }

    private void KillHelper()
    {
        if (helperProcess == IntPtr.Zero) return;
        TerminateProcess(helperProcess, 0);
        Native.CloseHandle(helperProcess);
        helperProcess = IntPtr.Zero;
        helperSession = Native.INVALID_SESSION;
    }

    /// <summary>Solo processi SYSTEM (l'helper) possono chiedere Ctrl+Alt+Canc.</summary>
    private void SasLoop()
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!stopping)
        {
            try
            {
                using var pipe = NamedPipeServerStreamAcl.Create("remoto-sas", PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 64, 64, security);
                pipe.WaitForConnectionAsync(cancel.Token).GetAwaiter().GetResult();
                if (pipe.ReadByte() == 1)
                {
                    Native.SendSAS(false);
                    pipe.WriteByte(1);
                    pipe.Flush();
                    Log.Write("Ctrl+Alt+Canc inviato");
                }
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception e)
            {
                Log.Write($"pipe SAS: {e.Message}");
                Thread.Sleep(1000);
            }
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool TerminateProcess(IntPtr handle, uint exitCode);
}
