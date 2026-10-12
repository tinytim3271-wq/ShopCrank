using System.Runtime.InteropServices;

namespace MechPro.J2534.Native;

/// <summary>Loads a vendor J2534 DLL and exposes Pass-Thru function delegates.</summary>
public sealed class PassThruLibrary : IDisposable
{
    readonly IntPtr _module;
    bool _disposed;

    public PassThruApi.PassThruOpenDelegate PassThruOpen { get; }
    public PassThruApi.PassThruCloseDelegate PassThruClose { get; }
    public PassThruApi.PassThruConnectDelegate PassThruConnect { get; }
    public PassThruApi.PassThruDisconnectDelegate PassThruDisconnect { get; }
    public PassThruApi.PassThruReadMsgsDelegate PassThruReadMsgs { get; }
    public PassThruApi.PassThruWriteMsgsDelegate PassThruWriteMsgs { get; }
    public PassThruApi.PassThruStartMsgFilterDelegate PassThruStartMsgFilter { get; }
    public PassThruApi.PassThruStopMsgFilterDelegate PassThruStopMsgFilter { get; }
    public PassThruApi.PassThruIoctlDelegate PassThruIoctl { get; }

    PassThruLibrary(
        IntPtr module,
        PassThruApi.PassThruOpenDelegate open,
        PassThruApi.PassThruCloseDelegate close,
        PassThruApi.PassThruConnectDelegate connect,
        PassThruApi.PassThruDisconnectDelegate disconnect,
        PassThruApi.PassThruReadMsgsDelegate readMsgs,
        PassThruApi.PassThruWriteMsgsDelegate writeMsgs,
        PassThruApi.PassThruStartMsgFilterDelegate startMsgFilter,
        PassThruApi.PassThruStopMsgFilterDelegate stopMsgFilter,
        PassThruApi.PassThruIoctlDelegate ioctl)
    {
        _module = module;
        PassThruOpen = open;
        PassThruClose = close;
        PassThruConnect = connect;
        PassThruDisconnect = disconnect;
        PassThruReadMsgs = readMsgs;
        PassThruWriteMsgs = writeMsgs;
        PassThruStartMsgFilter = startMsgFilter;
        PassThruStopMsgFilter = stopMsgFilter;
        PassThruIoctl = ioctl;
    }

    /// <summary>
    /// Build a library from already-resolved entry points. Used by tests to stand in
    /// for a vendor J2534 DLL without loading native code.
    /// </summary>
    public static PassThruLibrary FromDelegates(
        PassThruApi.PassThruOpenDelegate open,
        PassThruApi.PassThruCloseDelegate close,
        PassThruApi.PassThruConnectDelegate connect,
        PassThruApi.PassThruDisconnectDelegate disconnect,
        PassThruApi.PassThruReadMsgsDelegate readMsgs,
        PassThruApi.PassThruWriteMsgsDelegate writeMsgs,
        PassThruApi.PassThruStartMsgFilterDelegate startMsgFilter,
        PassThruApi.PassThruStopMsgFilterDelegate stopMsgFilter,
        PassThruApi.PassThruIoctlDelegate ioctl) =>
        new(IntPtr.Zero, open, close, connect, disconnect, readMsgs, writeMsgs, startMsgFilter, stopMsgFilter, ioctl);

    public static PassThruLibrary Load(string dllPath)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("J2534 Pass-Thru devices are only supported on Windows.");

        if (string.IsNullOrWhiteSpace(dllPath) || !File.Exists(dllPath))
            throw new FileNotFoundException($"J2534 DLL not found: {dllPath}");

        var module = PassThruApi.LoadLibrary(dllPath);
        if (module == IntPtr.Zero)
            throw new InvalidOperationException($"LoadLibrary failed for {dllPath} (win32={Marshal.GetLastWin32Error()})");

        try
        {
            return new PassThruLibrary(
                module,
                GetDelegate<PassThruApi.PassThruOpenDelegate>(module, "PassThruOpen"),
                GetDelegate<PassThruApi.PassThruCloseDelegate>(module, "PassThruClose"),
                GetDelegate<PassThruApi.PassThruConnectDelegate>(module, "PassThruConnect"),
                GetDelegate<PassThruApi.PassThruDisconnectDelegate>(module, "PassThruDisconnect"),
                GetDelegate<PassThruApi.PassThruReadMsgsDelegate>(module, "PassThruReadMsgs"),
                GetDelegate<PassThruApi.PassThruWriteMsgsDelegate>(module, "PassThruWriteMsgs"),
                GetDelegate<PassThruApi.PassThruStartMsgFilterDelegate>(module, "PassThruStartMsgFilter"),
                GetDelegate<PassThruApi.PassThruStopMsgFilterDelegate>(module, "PassThruStopMsgFilter"),
                GetDelegate<PassThruApi.PassThruIoctlDelegate>(module, "PassThruIoctl"));
        }
        catch
        {
            PassThruApi.FreeLibrary(module);
            throw;
        }
    }

    static T GetDelegate<T>(IntPtr module, string name) where T : Delegate
    {
        var address = PassThruApi.GetProcAddress(module, name);
        if (address == IntPtr.Zero)
            throw new EntryPointNotFoundException($"J2534 export not found: {name}");
        return Marshal.GetDelegateForFunctionPointer<T>(address);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_module != IntPtr.Zero)
            PassThruApi.FreeLibrary(_module);
    }
}
