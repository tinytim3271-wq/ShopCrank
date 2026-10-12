using MechPro.J2534.IsoTp;
using MechPro.J2534.Native;
using MechPro.J2534.Uds;

namespace MechPro.J2534.Core;

/// <summary>Manages a single J2534 diagnostic session with ISO-TP and UDS services.</summary>
public sealed class DiagnosticSession : IDisposable
{
    readonly List<CommLogEntry> _commLog = [];
    PassThruDevice? _device;
    bool _connected;
    bool _simulator;
    string? _adapterId;
    string? _adapterName;
    string? _dllPath;
    string? _protocol;
    double _voltage;
    bool _liveLogActive;
    bool _disposed;

    public bool IsSimulator => _simulator;

    KeyProcedureCatalog _keyCatalog = KeyProcedureCatalog.Default;

    /// <summary>Verified live key procedures. Defaults to the shipped (empty) catalog.</summary>
    public KeyProcedureCatalog KeyCatalog
    {
        get => _keyCatalog;
        set => _keyCatalog = value ?? KeyProcedureCatalog.Default;
    }

    /// <summary>Physical response CAN ID for a physical request ID (request + 8).</summary>
    public static string ResponseId(string requestId) => $"0x{CanAddress.Parse(requestId) + 8:X3}";

    public object Connect(ConnectParams p)
    {
        DisconnectInternal();

        _adapterId = p.AdapterId ?? "simulator";
        _protocol = p.Protocol ?? "ISO15765";
        _simulator = _adapterId == "simulator" || !OperatingSystem.IsWindows();

        if (_simulator)
        {
            _connected = true;
            _adapterName = "MechPro CAN Simulator";
            _dllPath = "builtin-simulator";
            _voltage = 12.6;
            Log("tx", "0x7E0", "1003", "Diagnostic session start (simulator)");
            Log("rx", "0x7E8", "5003", "Positive response (simulator)");
            return new { connected = true, protocol = _protocol, voltage = _voltage, simulator = true };
        }

        var adapter = AdapterRegistry.Resolve(_adapterId)
            ?? throw new InvalidOperationException($"Unknown adapter: {_adapterId}");

        if (string.IsNullOrWhiteSpace(adapter.DllPath) || !File.Exists(adapter.DllPath))
            throw new InvalidOperationException($"J2534 DLL not found for adapter '{adapter.Name}'. Install the vendor driver.");

        if (!adapter.Usable)
            throw new InvalidOperationException(adapter.UsabilityNote);

        return AttachDevice(PassThruDevice.Open(adapter.DllPath, adapter.Name), adapter.Id, adapter.Name, adapter.DllPath, (uint)(p.BaudRate ?? 500_000));
    }

    /// <summary>Attach an opened Pass-Thru device. Connect uses this; tests pass a device backed by a mocked J2534 DLL.</summary>
    public object AttachDevice(PassThruDevice device, string adapterId, string adapterName, string dllPath, uint baudRate = 500_000)
    {
        DisconnectInternal();
        _adapterId = adapterId;
        _protocol = "ISO15765";
        _simulator = false;
        _device = device;
        _device.Connect(PassThruApi.PROTOCOL_ISO15765, baudRate);
        _adapterName = adapterName;
        _dllPath = dllPath;
        _voltage = _device.ReadVoltage();
        if (_voltage <= 0) _voltage = 12.0;
        _connected = true;

        var channel = CreateChannel();
        var client = new UdsClient(channel);
        try
        {
            _ = client.SendTesterPresent("0x7E0", "0x7E8");
            Log("tx", "0x7E0", "3E00", "Tester present");
        }
        catch
        {
            // Vehicle may not respond until ignition is on — connection still valid.
        }

        return new { connected = true, protocol = _protocol, voltage = _voltage, simulator = false };
    }

    public object Disconnect()
    {
        DisconnectInternal();
        return new { connected = false };
    }

    void DisconnectInternal()
    {
        _connected = false;
        _liveLogActive = false;
        _device?.Dispose();
        _device = null;
    }

    public object GetConnectionStatus() =>
        _connected
            ? new
            {
                connected = true,
                adapterId = _adapterId,
                protocol = _protocol,
                voltage = _voltage,
                commFault = false,
                simulator = _simulator,
                adapterName = _adapterName,
                dllPath = _dllPath,
            }
            : new
            {
                connected = false,
                adapterId = (string?)null,
                protocol = (string?)null,
                voltage = (double?)null,
                commFault = false,
                simulator = false,
                adapterName = (string?)null,
                dllPath = (string?)null,
            };

    public async Task<string> ReadConnectedVinAsync()
    {
        RequireConnected();
        var channel = CreateChannel();
        try
        {
            // Generic OBD-II mode 09 works on every CAN vehicle; fall back to UDS F190.
            var vin = new ObdClient(channel).ReadVin();
            if (vin.Length == 17) return vin;
        }
        catch
        {
            // Fall through to UDS.
        }
        return await new UdsClient(channel).ReadVinAsync("0x7E0", "0x7E8");
    }

    public async Task<object> ReadVinAsync()
    {
        var vin = await ReadConnectedVinAsync();
        return new { vin, source = "UDS_22_F190", raw = vin };
    }

    public async Task<object> IdentifyEcusAsync()
    {
        RequireConnected();
        var client = new UdsClient(CreateChannel());
        var addresses = new[] { ("0x7E0", "Gateway (SGW)"), ("0x7E1", "ECM"), ("0x7E2", "TCM"), ("0x7E3", "BCM") };
        var ecus = new List<object>();
        foreach (var (addr, name) in addresses)
        {
            try
            {
                var info = await client.ReadEcuIdentificationAsync(addr, ResponseId(addr));
                ecus.Add(new { logicalAddress = addr, name, partNumber = info.PartNumber, softwareVersion = info.SoftwareVersion, calibrationId = info.CalibrationId });
            }
            catch (Exception ex)
            {
                ecus.Add(new { logicalAddress = addr, name, partNumber = "unavailable", softwareVersion = ex.Message, calibrationId = "" });
            }
        }
        var securityModules = new[]
        {
            new { type = "gateway", logicalAddress = "0x7E0", partNumber = "unknown", generation = "SGW" },
            new { type = "rf_hub", logicalAddress = "0x7E4", partNumber = "unknown", generation = "unknown" },
        };
        return new { ecus, securityModules, networkTopology = addresses.Select(a => a.Item1).Append("0x7E4").ToArray() };
    }

    public async Task<object> ReadDtcsAsync()
    {
        RequireConnected();
        var client = new UdsClient(CreateChannel());
        var dtcs = await client.ReadDtcsAsync("0x7E0", "0x7E8");
        return new { dtcs };
    }

    public async Task<object> ClearDtcsAsync()
    {
        RequireConnected();
        var client = new UdsClient(CreateChannel());
        await client.ClearDtcsAsync("0x7E0", "0x7E8");
        return new { cleared = true };
    }

    // --- Programming: security access, key programming, and module reflash ---

    string? _securityScope;
    long _securityUnlockedAt;
    readonly List<object> _keys = [];
    readonly List<object> _remotes = [];

    ISecurityAccessProvider SecurityProvider() =>
        _simulator ? new SimulatorSecurityAccessProvider() : new FailClosedSecurityAccessProvider();

    static int SecurityLevel(string scope) => scope == "flash" ? 0x05 : 0x03;

    public Task<object> SecurityAccessAsync(string scope)
    {
        RequireConnected();
        var normalized = scope == "flash" ? "flash" : "immobilizer";
        var level = SecurityLevel(normalized);
        var provider = SecurityProvider();
        if (_simulator)
        {
            Log("tx", "0x7E0", $"27{level:X2}", $"SecurityAccess requestSeed ({normalized})");
            Log("rx", "0x7E8", $"67{level:X2}A1B2C3D4", "Seed");
            Log("tx", "0x7E0", $"27{level + 1:X2}", "sendKey");
            Log("rx", "0x7E8", $"67{level + 1:X2}", "SecurityAccess granted");
        }
        else
        {
            var client = new UdsClient(CreateChannel());
            client.DiagnosticSessionControl(0x02, "0x7E0", "0x7E8");
            client.SecurityAccess(level, provider, "", "0x7E0", "0x7E8");
            Log("tx", "0x7E0", $"27{level:X2}", $"SecurityAccess ({provider.Name})");
        }
        _securityScope = normalized;
        _securityUnlockedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return Task.FromResult<object>(new { unlocked = true, scope = normalized, level });
    }

    void RequireSecurity(string scope)
    {
        if (_securityScope != scope)
            throw new InvalidOperationException($"SecurityAccess ({scope}) required before this procedure");
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - _securityUnlockedAt > 10 * 60 * 1000)
        {
            _securityScope = null;
            throw new InvalidOperationException("SecurityAccess session expired; re-authenticate");
        }
    }

    public Task<object> ProgramKeyAsync(string procedure, string vin, string? pin = null)
    {
        RequireConnected();
        if (!_simulator)
        {
            // Live writes only run a procedure that has been verified for this vehicle.
            // Nothing is sent to the vehicle when there isn't one.
            var support = _keyCatalog.Evaluate(procedure, vin, simulator: false);
            if (!support.Supported) throw new NotSupportedException(support.Reason);
            var definition = _keyCatalog.Find(procedure, vin)!;
            if (definition.RequiresVehiclePin && string.IsNullOrWhiteSpace(pin))
                throw new InvalidOperationException("This vehicle asks for its immobilizer PIN for this procedure. Enter the PIN to continue, or stop here. MechPro does not work around vehicle security.");
            Log("tx", "-", "", $"Live key procedure start: {procedure} for {vin}");
            var result = definition.Execute!(new KeyProcedureContext { Vin = vin, Procedure = procedure, Pin = pin, Log = Log, Channel = CreateChannel() });
            Log("rx", "-", "", $"Live key procedure finished: {procedure}");
            return Task.FromResult(result);
        }
        RequireSecurity("immobilizer");
        var routine = procedure switch
        {
            "add_key" => (Id: (ushort)0x0301, Label: "Program spare key"),
            "all_keys_lost" => (Id: (ushort)0x0302, Label: "All keys lost — provision new key"),
            "program_remote" => (Id: (ushort)0x0303, Label: "Program RF remote"),
            "erase_keys" => (Id: (ushort)0x0304, Label: "Erase and relearn keys"),
            _ => throw new InvalidOperationException($"Unsupported key procedure: {procedure}"),
        };
        Log("tx", "0x7E4", $"3101{routine.Id:X4}", $"RoutineControl: {routine.Label} (simulator)");
        Log("rx", "0x7EC", $"7101{routine.Id:X4}00", "Routine result: success");
        var now = DateTime.UtcNow.ToString("o");
        switch (procedure)
        {
            case "erase_keys": _keys.Clear(); _remotes.Clear(); break;
            case "all_keys_lost": _keys.Clear(); _keys.Add(new { id = $"key-{now}", type = "transponder", programmedAt = now }); break;
            case "add_key": _keys.Add(new { id = $"key-{now}", type = "transponder", programmedAt = now }); break;
            case "program_remote": _remotes.Add(new { id = $"rke-{now}", type = "rf_hub", programmedAt = now }); break;
        }
        return Task.FromResult<object>(new
        {
            procedure, completed = true, vin, keys = _keys.Count, remotes = _remotes.Count, routine = $"0x{routine.Id:X4}", completedAt = now,
        });
    }

    public Task<object> FlashModuleAsync(string target, byte[] firmware, string version, string vin)
    {
        RequireConnected();
        RequireSecurity("flash");
        var size = firmware.Length;
        var blocks = Math.Max(1, (size + 0x3FF) / 0x400);
        if (!_simulator)
        {
            var client = new UdsClient(CreateChannel());
            client.DownloadFirmware(firmware, target, ResponseId(target),
                (block, total) => Log("tx", target, $"36{block & 0xFF:X2}", $"TransferData block {block}/{total}"));
        }
        else
        {
            Log("tx", target, $"34{size:X8}", $"RequestDownload: {size} bytes");
            for (var i = 1; i <= blocks; i++) Log("tx", target, $"36{i & 0xFF:X2}", $"TransferData block {i}/{blocks}");
            Log("tx", target, "37", "RequestTransferExit");
        }
        var now = DateTime.UtcNow.ToString("o");
        return Task.FromResult<object>(new
        {
            procedure = "module_flash", completed = true, vin, target, bytes = size, blocks, softwareVersion = version, completedAt = now,
        });
    }

    static readonly Dictionary<string, (ushort Did, byte Option, string Label)> BidirectionalControls = new()
    {
        ["cooling_fan"] = (0xD100, 0x03, "Cooling fan"),
        ["fuel_pump"] = (0xD101, 0x03, "Fuel pump"),
        ["ac_clutch"] = (0xD102, 0x03, "A/C clutch"),
        ["evap_purge"] = (0xD103, 0x03, "EVAP purge"),
        ["return_control"] = (0xD100, 0x00, "Return control to ECU"),
    };

    public Task<object> BidirectionalControlAsync(string control, string state, string vin)
    {
        RequireConnected();
        if (!BidirectionalControls.TryGetValue(control, out var spec))
            throw new InvalidOperationException("Unsupported bidirectional control");
        var option = state == "off" || control == "return_control" ? (byte)0x00 : spec.Option;
        if (!_simulator)
        {
            var client = new UdsClient(CreateChannel());
            client.DiagnosticSessionControl(0x03, "0x7E0", "0x7E8");
            client.InputOutputControl(spec.Did, option, "0x7E0", "0x7E8");
        }
        Log("tx", "0x7E0", "1003", "Extended diagnostic session (0x10 0x03)");
        Log("tx", "0x7E0", $"2F{spec.Did:X4}{option:X2}", $"InputOutputControl: {spec.Label}");
        return Task.FromResult<object>(new
        {
            procedure = "bidirectional_control",
            completed = true,
            vin,
            control,
            state = option == 0 ? "released" : "active",
        });
    }

    public Task<object> CodeModuleAsync(string target, ushort did, byte[] data, string vin)
    {
        RequireConnected();
        RequireSecurity("flash");
        if (!_simulator)
        {
            var client = new UdsClient(CreateChannel());
            var rx = ResponseId(target);
            client.WriteDataByIdentifier(did, data, target, rx);
        }
        Log("tx", target, $"2E{did:X4}", "WriteDataByIdentifier");
        return Task.FromResult<object>(new
        {
            procedure = "module_coding",
            completed = true,
            vin,
            target,
            did = $"0x{did:X4}",
            bytes = data.Length,
        });
    }

    // --- Generic OBD-II (SAE J1979) for the OBD bay ---

    public object ObdSnapshot()
    {
        RequireConnected();
        var obd = new ObdClient(CreateChannel());
        var errors = new List<string>();
        var vin = "";
        try { vin = obd.ReadVin(); } catch (Exception ex) { errors.Add($"VIN: {ex.Message}"); }
        var supported = new HashSet<byte>();
        try { supported = obd.ReadSupportedPids(); } catch (Exception ex) { errors.Add($"Supported PIDs: {ex.Message}"); }
        var responded = vin.Length > 0 || supported.Count > 0;

        ObdMonitorStatus? monitor = null;
        var readings = new List<ObdPidReading>();
        string[] stored = [], pending = [], permanent = [];
        if (responded)
        {
            if (supported.Contains(0x01))
            {
                try { monitor = obd.ReadMonitorStatus(); } catch (Exception ex) { errors.Add($"Monitor status: {ex.Message}"); }
            }
            foreach (var pid in ObdClient.SnapshotPids.Where(supported.Contains))
            {
                try { readings.Add(obd.ReadPid(pid)); } catch (Exception ex) { errors.Add($"PID 0x{pid:X2}: {ex.Message}"); }
            }
            try { stored = obd.ReadDtcs(0x03); } catch (Exception ex) { errors.Add($"Stored codes: {ex.Message}"); }
            try { pending = obd.ReadDtcs(0x07); } catch (Exception ex) { errors.Add($"Pending codes: {ex.Message}"); }
            try { permanent = obd.ReadDtcs(0x0A); }
            catch (ObdNegativeResponseException) { /* permanent codes are optional before 2010 */ }
            catch (Exception ex) { errors.Add($"Permanent codes: {ex.Message}"); }
        }
        else
        {
            errors.Add("No reply from the engine ECU on 11-bit CAN at 500 kbps. Check ignition ON and the DLC connection. Pre-2008 vehicles on J1850, ISO 9141 or KWP2000, and 29-bit CAN vehicles, are not supported by the OBD bay yet.");
        }

        return new
        {
            source = _simulator ? "simulator" : "live",
            simulator = _simulator,
            adapterName = _adapterName,
            protocol = "ISO 15765-4 CAN 11-bit 500 kbps (engine ECU 0x7E0)",
            responded,
            vin,
            milOn = monitor?.MilOn,
            reportedDtcCount = monitor?.DtcCount,
            supportedPids = supported.OrderBy(p => p).Select(p => $"0x{p:X2}").ToArray(),
            readings,
            storedDtcs = stored,
            pendingDtcs = pending,
            permanentDtcs = permanent,
            errors,
            voltage = _voltage,
            readAt = DateTime.UtcNow.ToString("o"),
        };
    }

    public object ObdClearDtcs(bool confirmed)
    {
        RequireConnected();
        if (!confirmed)
            throw new InvalidOperationException("Clearing codes also erases freeze-frame data and readiness monitors. Confirm before clearing.");
        new ObdClient(CreateChannel()).ClearDtcs();
        return new { cleared = true, simulator = _simulator, clearedAt = DateTime.UtcNow.ToString("o") };
    }

    public async Task<KeyProcedureSupport> KeyProcedureSupportAsync(string procedure)
    {
        RequireConnected();
        var vin = "";
        try { vin = await ReadConnectedVinAsync(); } catch { /* reported as an unreadable VIN */ }
        return _keyCatalog.Evaluate(procedure, vin, _simulator);
    }

    public object StartLiveLog()
    {
        RequireConnected();
        _liveLogActive = true;
        return new { active = true };
    }

    public object StopLiveLog()
    {
        _liveLogActive = false;
        return new { active = false };
    }

    public object PollLiveLog(long since)
    {
        if (_liveLogActive && _connected && !_simulator && _device is not null)
        {
            try
            {
                _voltage = _device.ReadVoltage();
            }
            catch { /* ignore voltage poll errors */ }
        }
        var entries = _commLog.Where(e => e.Timestamp > since).ToList();
        return new { entries };
    }

    public async Task<object> IdentifyVehicleAsync()
    {
        RequireConnected();
        var vinResult = await ReadVinAsync();
        var vin = ((dynamic)vinResult).vin as string ?? "";
        var ecuResult = await IdentifyEcusAsync();
        return new
        {
            sessionId = $"diag-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}",
            vin,
            make = InferMake(vin),
            modelYear = InferModelYear(vin),
            platform = "unknown",
            ignitionType = "push_button",
            ecus = ((dynamic)ecuResult).ecus,
            securityModules = ((dynamic)ecuResult).securityModules,
            networkTopology = ((dynamic)ecuResult).networkTopology,
            identifiedAt = DateTime.UtcNow.ToString("o"),
            adapterInfo = new
            {
                vendor = _simulator ? "MechPro" : _adapterName,
                dll = _dllPath,
                firmware = _simulator ? "1.0.0-sim" : "J2534",
            },
            simulator = _simulator,
        };
    }

    IIsoTpChannel CreateChannel() =>
        _simulator || _device is null
            ? new SimulatedIsoTpChannel(Log)
            : new J2534IsoTpChannel(_device, Log);

    static string InferMake(string vin)
    {
        if (vin.Length < 3) return "Unknown";
        var wmi = vin[..3].ToUpperInvariant();
        return wmi is "1C6" or "3C6" ? "Ram" : wmi is "1D7" or "1B3" ? "Dodge" : "Stellantis";
    }

    static int InferModelYear(string vin)
    {
        if (vin.Length < 10) return 0;
        var code = vin[9];
        if (code is >= 'A' and <= 'Z') return 2010 + (code - 'A');
        if (code is >= '0' and <= '9') return 2000 + (code - '0');
        return 0;
    }

    void RequireConnected()
    {
        if (!_connected) throw new InvalidOperationException("Not connected. Select an adapter and connect first.");
    }

    void Log(string direction, string address, string data, string description) =>
        _commLog.Add(new CommLogEntry
        {
            Timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Direction = direction,
            Address = address,
            Data = data,
            Description = description,
        });

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        DisconnectInternal();
    }
}

public sealed class CommLogEntry
{
    public long Timestamp { get; set; }
    public string Direction { get; set; } = "";
    public string Address { get; set; } = "";
    public string Data { get; set; } = "";
    public string Description { get; set; } = "";
}
