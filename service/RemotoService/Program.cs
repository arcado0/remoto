using System.Security.Principal;

namespace Remoto.Service;

internal static class Program
{
    public const string ServiceName = "RemotoService";

    private static int Main(string[] args)
    {
        var mode = args.Length > 0 ? args[0].ToLowerInvariant() : "";
        try
        {
            return mode switch
            {
                "install" => Installer.Install(),
                "uninstall" => Installer.Uninstall(),
                "helper" => new Helper(args.Length > 1 && uint.TryParse(args[1], out var s) ? s : CurrentSession()).Run(),
                "" => ServiceHost.Run(),
                _ => 1,
            };
        }
        catch (Exception e)
        {
            Log.Write($"errore non gestito ({mode}): {e}");
            return 3;
        }
    }

    public static uint CurrentSession()
    {
        Native.ProcessIdToSessionId((uint)Environment.ProcessId, out var s);
        return s;
    }

    public static bool IsSystem()
    {
        using var id = WindowsIdentity.GetCurrent();
        return id.User?.IsWellKnown(WellKnownSidType.LocalSystemSid) == true;
    }
}

internal static class Log
{
    private static readonly object Gate = new();
    private static readonly string File = Path.Combine(
        Program.IsSystem() ? Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData) : Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Remoto", "logs", "servizio.log");

    public static void Write(string message)
    {
        try
        {
            lock (Gate)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(File)!);
                var info = new FileInfo(File);
                if (info.Exists && info.Length > 2 * 1024 * 1024) info.MoveTo(File + ".1", true);
                System.IO.File.AppendAllText(File, $"{DateTime.UtcNow:O} [{Environment.ProcessId}] {message}{Environment.NewLine}");
            }
        }
        catch
        {
            // il log non deve mai fermare il servizio
        }
    }
}
