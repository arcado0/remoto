using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32;

namespace Remoto.Service;

/// <summary>
/// Installazione e rimozione del servizio (richiedono amministratore).
/// Codici di uscita: 0 ok, 4 eseguibile fuori da Programmi, 5 non amministratore, 6 errore del Gestore servizi.
/// </summary>
internal static class Installer
{
    private const string DisplayName = "Remoto - controllo completo";
    private const string Description = "Permette a Remoto di controllare finestre di amministratore, richieste UAC e schermata di blocco durante le sessioni accettate dall'utente. Accetta comandi solo da Remoto installato in Programmi.";
    private const string PolicyKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
    private const string StateKey = @"SOFTWARE\Remoto\Servizio";

    private static bool IsAdmin()
    {
        using var id = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private static int Fail(string what)
    {
        Log.Write($"{what} non riuscito: errore {Marshal.GetLastWin32Error()}");
        return 6;
    }

    public static int Install()
    {
        if (!IsAdmin())
        {
            Log.Write("installazione: servono i diritti di amministratore");
            return 5;
        }
        var exe = Environment.ProcessPath!;
        // un servizio SYSTEM deve stare dove gli utenti non possono sostituirlo
        if (!Helper.IsProtectedLocation(exe))
        {
            Log.Write($"installazione rifiutata: {exe} non è nella cartella Programmi");
            return 4;
        }
        var scm = Native.OpenSCManagerW(null, null, Native.SC_MANAGER_ALL_ACCESS);
        if (scm == IntPtr.Zero) return Fail("OpenSCManager");
        try
        {
            var bin = $"\"{exe}\"";
            var svc = Native.CreateServiceW(scm, Program.ServiceName, DisplayName, Native.SERVICE_ALL_ACCESS, Native.SERVICE_WIN32_OWN_PROCESS, Native.SERVICE_AUTO_START, Native.SERVICE_ERROR_NORMAL, bin, null, IntPtr.Zero, null, null, null);
            if (svc == IntPtr.Zero)
            {
                if (Marshal.GetLastWin32Error() != Native.ERROR_SERVICE_EXISTS) return Fail("CreateService");
                svc = Native.OpenServiceW(scm, Program.ServiceName, Native.SERVICE_ALL_ACCESS);
                if (svc == IntPtr.Zero) return Fail("OpenService");
                Native.ChangeServiceConfigW(svc, Native.SERVICE_NO_CHANGE, Native.SERVICE_AUTO_START, Native.SERVICE_NO_CHANGE, bin, null, IntPtr.Zero, null, null, null, DisplayName);
            }
            try
            {
                var desc = new Native.SERVICE_DESCRIPTIONW { lpDescription = Description };
                Native.ChangeServiceConfig2W(svc, Native.SERVICE_CONFIG_DESCRIPTION, ref desc);
                SetRestartOnFailure(svc);
                EnableSoftwareSas();
                if (!Native.StartServiceW(svc, 0, IntPtr.Zero) && Marshal.GetLastWin32Error() != 1056 /* già in esecuzione */) return Fail("StartService");
                Log.Write($"servizio installato: {exe}");
                return 0;
            }
            finally
            {
                Native.CloseServiceHandle(svc);
            }
        }
        finally
        {
            Native.CloseServiceHandle(scm);
        }
    }

    public static int Uninstall()
    {
        if (!IsAdmin()) return 5;
        var scm = Native.OpenSCManagerW(null, null, Native.SC_MANAGER_ALL_ACCESS);
        if (scm == IntPtr.Zero) return Fail("OpenSCManager");
        try
        {
            var svc = Native.OpenServiceW(scm, Program.ServiceName, Native.SERVICE_ALL_ACCESS);
            if (svc == IntPtr.Zero)
            {
                if (Marshal.GetLastWin32Error() == Native.ERROR_SERVICE_DOES_NOT_EXIST)
                {
                    RestoreSoftwareSas();
                    return 0;
                }
                return Fail("OpenService");
            }
            try
            {
                var st = new Native.SERVICE_STATUS();
                Native.ControlService(svc, Native.SERVICE_CONTROL_STOP, ref st);
                for (int i = 0; i < 50 && Native.QueryServiceStatus(svc, ref st) && st.dwCurrentState != Native.SERVICE_STOPPED; i++) Thread.Sleep(200);
                if (!Native.DeleteService(svc)) return Fail("DeleteService");
            }
            finally
            {
                Native.CloseServiceHandle(svc);
            }
        }
        finally
        {
            Native.CloseServiceHandle(scm);
        }
        RestoreSoftwareSas();
        Log.Write("servizio rimosso");
        return 0;
    }

    private static void SetRestartOnFailure(IntPtr svc)
    {
        var actions = new[] { new Native.SC_ACTION { Type = 1, Delay = 5000 }, new Native.SC_ACTION { Type = 1, Delay = 15000 } };
        int size = Marshal.SizeOf<Native.SC_ACTION>();
        var buffer = Marshal.AllocHGlobal(size * actions.Length);
        try
        {
            for (int i = 0; i < actions.Length; i++) Marshal.StructureToPtr(actions[i], buffer + i * size, false);
            var info = new Native.SERVICE_FAILURE_ACTIONSW { dwResetPeriod = 86400, cActions = (uint)actions.Length, lpsaActions = buffer };
            Native.ChangeServiceConfig2W(svc, Native.SERVICE_CONFIG_FAILURE_ACTIONS, ref info);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    /// <summary>Criterio di Windows che consente ai servizi di generare Ctrl+Alt+Canc (SendSAS).</summary>
    private static void EnableSoftwareSas()
    {
        using var policy = Registry.LocalMachine.CreateSubKey(PolicyKey, true);
        using var state = Registry.LocalMachine.CreateSubKey(StateKey, true);
        var previous = policy.GetValue("SoftwareSASGeneration");
        if (state.GetValue("PrevSoftwareSASGeneration") is null)
            state.SetValue("PrevSoftwareSASGeneration", previous is int p ? p : -1, RegistryValueKind.DWord);
        int current = previous is int c ? c : 0;
        policy.SetValue("SoftwareSASGeneration", current is 2 or 3 ? 3 : 1, RegistryValueKind.DWord);
    }

    private static void RestoreSoftwareSas()
    {
        using var state = Registry.LocalMachine.OpenSubKey(StateKey, true);
        if (state?.GetValue("PrevSoftwareSASGeneration") is not int prev) return;
        using (var policy = Registry.LocalMachine.CreateSubKey(PolicyKey, true))
        {
            if (prev < 0) policy.DeleteValue("SoftwareSASGeneration", false);
            else policy.SetValue("SoftwareSASGeneration", prev, RegistryValueKind.DWord);
        }
        Registry.LocalMachine.DeleteSubKeyTree(@"SOFTWARE\Remoto\Servizio", false);
    }
}
