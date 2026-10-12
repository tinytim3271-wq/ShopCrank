using System.Runtime.InteropServices;

namespace MechPro.J2534.Native;

/// <summary>Active J2534 device session over ISO15765 for UDS diagnostic requests.</summary>
public sealed class PassThruDevice : IDisposable
{
    readonly PassThruLibrary _library;
    uint _deviceId;
    uint _channelId;
    uint _filterId;
    bool _opened;
    bool _connected;
    bool _disposed;

    public string DllPath { get; }
    public string AdapterName { get; }

    PassThruDevice(PassThruLibrary library, string dllPath, string adapterName)
    {
        _library = library;
        DllPath = dllPath;
        AdapterName = adapterName;
    }

    public static PassThruDevice Open(string dllPath, string adapterName) =>
        Open(PassThruLibrary.Load(dllPath), dllPath, adapterName);

    /// <summary>Open a device from an already-loaded library (also used with a mocked J2534 DLL in tests).</summary>
    public static PassThruDevice Open(PassThruLibrary library, string dllPath, string adapterName)
    {
        var device = new PassThruDevice(library, dllPath, adapterName);
        device.OpenDevice();
        return device;
    }

    void OpenDevice()
    {
        EnsureNotDisposed();
        var status = _library.PassThruOpen(IntPtr.Zero, ref _deviceId);
        if (status != J2534Status.STATUS_NOERROR)
            throw new InvalidOperationException($"PassThruOpen failed: 0x{status:X2}");
        _opened = true;
    }

    public void Connect(uint protocolId = PassThruApi.PROTOCOL_ISO15765, uint baudRate = 500_000)
    {
        EnsureNotDisposed();
        if (!_opened) throw new InvalidOperationException("Device is not open.");
        if (_connected) Disconnect();

        var status = _library.PassThruConnect(_deviceId, protocolId, 0, baudRate, ref _channelId);
        if (status != J2534Status.STATUS_NOERROR)
            throw new InvalidOperationException($"PassThruConnect failed: 0x{status:X2}");

        _connected = true;
    }

    public void ConfigureIso15765Pair(uint txCanId, uint rxCanId)
    {
        EnsureNotDisposed();
        if (!_connected) throw new InvalidOperationException("Channel is not connected.");

        if (_filterId != 0)
        {
            _library.PassThruStopMsgFilter(_channelId, _filterId);
            _filterId = 0;
        }

        var mask = PassThruMsgHelper.Create(PassThruApi.PROTOCOL_ISO15765, 0x000007FF, []);
        var pattern = PassThruMsgHelper.Create(PassThruApi.PROTOCOL_ISO15765, rxCanId, []);
        var flowControl = PassThruMsgHelper.Create(PassThruApi.PROTOCOL_ISO15765, txCanId, []);

        var filterId = 0u;
        var status = InvokeFilter(mask, pattern, flowControl, ref filterId);
        if (status != J2534Status.STATUS_NOERROR)
            throw new InvalidOperationException($"PassThruStartMsgFilter failed: 0x{status:X2}");
        _filterId = filterId;
    }

    int InvokeFilter(PassThruMsg mask, PassThruMsg pattern, PassThruMsg flowControl, ref uint filterId)
    {
        var maskPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PassThruMsg>());
        var patternPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PassThruMsg>());
        var flowPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PassThruMsg>());
        try
        {
            Marshal.StructureToPtr(mask, maskPtr, false);
            Marshal.StructureToPtr(pattern, patternPtr, false);
            Marshal.StructureToPtr(flowControl, flowPtr, false);
            return _library.PassThruStartMsgFilter(
                _channelId,
                J2534Status.FILTER_FLOW_CONTROL_FILTER,
                maskPtr,
                patternPtr,
                flowPtr,
                ref filterId);
        }
        finally
        {
            Marshal.FreeHGlobal(maskPtr);
            Marshal.FreeHGlobal(patternPtr);
            Marshal.FreeHGlobal(flowPtr);
        }
    }

    public byte[] Transact(uint txCanId, uint rxCanId, byte[] request, int timeoutMs = 5000)
    {
        EnsureNotDisposed();
        if (!_connected) throw new InvalidOperationException("Channel is not connected.");

        ConfigureIso15765Pair(txCanId, rxCanId);

        var writeMsg = PassThruMsgHelper.Create(
            PassThruApi.PROTOCOL_ISO15765,
            txCanId,
            request,
            J2534Status.ISO15765_FRAME_PAD);

        var writeCount = 1u;
        var writePtr = Marshal.AllocHGlobal(Marshal.SizeOf<PassThruMsg>());
        try
        {
            Marshal.StructureToPtr(writeMsg, writePtr, false);
            var status = _library.PassThruWriteMsgs(_channelId, writePtr, ref writeCount, (uint)timeoutMs);
            if (status != J2534Status.STATUS_NOERROR)
                throw new InvalidOperationException($"PassThruWriteMsgs failed: 0x{status:X2}");
        }
        finally
        {
            Marshal.FreeHGlobal(writePtr);
        }

        return ReadIso15765Response(rxCanId, timeoutMs);
    }

    byte[] ReadIso15765Response(uint rxCanId, int timeoutMs)
    {
        var deadline = Environment.TickCount64 + timeoutMs;

        while (Environment.TickCount64 < deadline)
        {
            var readMsg = new PassThruMsg { Data = new byte[4128] };
            var readCount = 1u;
            var readPtr = Marshal.AllocHGlobal(Marshal.SizeOf<PassThruMsg>());
            try
            {
                Marshal.StructureToPtr(readMsg, readPtr, false);
                var status = _library.PassThruReadMsgs(_channelId, readPtr, ref readCount, 250);
                if (status == J2534Status.ERR_BUFFER_EMPTY || status == J2534Status.ERR_TIMEOUT || readCount == 0)
                    continue;
                if (status != J2534Status.STATUS_NOERROR)
                    throw new InvalidOperationException($"PassThruReadMsgs failed: 0x{status:X2}");

                readMsg = Marshal.PtrToStructure<PassThruMsg>(readPtr)!;
            }
            finally
            {
                Marshal.FreeHGlobal(readPtr);
            }

            // Skip our own transmit indications and first-frame notifications.
            if ((readMsg.RxStatus & (J2534Status.TX_MSG_TYPE | J2534Status.ISO15765_FIRST_FRAME)) != 0) continue;
            if (readMsg.DataSize <= 4) continue;
            var canId = PassThruMsgHelper.ReadCanId(readMsg.Data.AsSpan(0, 4));
            if (canId != rxCanId) continue;

            var payload = readMsg.Data.AsSpan(4, (int)readMsg.DataSize - 4).ToArray();
            // 0x7F <sid> 0x78 = response pending; the ECU will answer later.
            if (payload.Length >= 3 && payload[0] == 0x7F && payload[2] == 0x78)
            {
                deadline = Math.Max(deadline, Environment.TickCount64 + timeoutMs);
                continue;
            }
            return payload;
        }

        throw new TimeoutException($"No ISO15765 response from 0x{rxCanId:X} within {timeoutMs}ms.");
    }

    public double ReadVoltage()
    {
        EnsureNotDisposed();
        if (!_opened) return 0;

        var output = Marshal.AllocHGlobal(sizeof(uint));
        try
        {
            var status = _library.PassThruIoctl(_channelId != 0 ? _channelId : _deviceId, PassThruApi.IOCTL_READ_VBATT, IntPtr.Zero, output);
            if (status != J2534Status.STATUS_NOERROR) return 0;
            var millivolts = Marshal.ReadInt32(output);
            return Math.Round(millivolts / 1000.0, 1);
        }
        finally
        {
            Marshal.FreeHGlobal(output);
        }
    }

    public void Disconnect()
    {
        if (!_connected) return;
        if (_filterId != 0)
        {
            _library.PassThruStopMsgFilter(_channelId, _filterId);
            _filterId = 0;
        }
        _library.PassThruDisconnect(_channelId);
        _channelId = 0;
        _connected = false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        try { Disconnect(); } catch { /* ignore */ }
        if (_opened)
        {
            try { _library.PassThruClose(_deviceId); } catch { /* ignore */ }
            _opened = false;
        }
        _library.Dispose();
    }

    void EnsureNotDisposed()
    {
        if (_disposed) throw new ObjectDisposedException(nameof(PassThruDevice));
    }
}
