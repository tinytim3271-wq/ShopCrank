using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using ShopCrank.J2534.Core;
using ShopCrank.J2534.Native;
using ShopCrank.J2534.Uds;
using Xunit;

namespace ShopCrank.J2534.Host.Tests;

/// <summary>
/// A stand-in for a vendor J2534 DLL (such as TOPDON PassThru464.dll). It
/// implements the PassThru* exports the host calls, marshals PASSTHRU_MSG
/// structures through unmanaged memory like a real driver, and behaves like an
/// ISO15765 channel: it returns whole reassembled payloads and also emits the
/// TX-echo and first-frame indications that real drivers send.
/// </summary>
sealed class FakeJ2534Dll
{
    const uint TxMsgType = 0x01;
    const uint Iso15765FirstFrame = 0x02;

    readonly Queue<PassThruMsg> _rx = new();
    public List<(uint CanId, byte[] Payload)> AddressedRequests { get; } = [];
    public uint Protocol { get; private set; }
    public uint Baud { get; private set; }
    public Func<uint, byte[], IEnumerable<byte[]>> Responder { get; set; } = (_, request) => [[0x7F, request[0], 0x11]];

    public PassThruLibrary CreateLibrary() => PassThruLibrary.FromDelegates(
        (IntPtr name, ref uint deviceId) => { deviceId = 1; return 0; },
        deviceId => 0,
        (uint deviceId, uint protocol, uint flags, uint baud, ref uint channelId) => { Protocol = protocol; Baud = baud; channelId = 7; return 0; },
        channelId => 0,
        Read,
        Write,
        (uint channelId, uint type, IntPtr mask, IntPtr pattern, IntPtr flow, ref uint filterId) => { filterId = 3; return 0; },
        (channelId, filterId) => 0,
        (channelId, ioctl, input, output) =>
        {
            if (ioctl != PassThruApi.IOCTL_READ_VBATT) return 0x07;
            Marshal.WriteInt32(output, 12480);
            return 0;
        });

    int Write(uint channelId, IntPtr pMsg, ref uint count, uint timeout)
    {
        var msg = Marshal.PtrToStructure<PassThruMsg>(pMsg);
        var canId = PassThruMsgHelper.ReadCanId(msg.Data);
        var payload = msg.Data.AsSpan(4, (int)msg.DataSize - 4).ToArray();
        AddressedRequests.Add((canId, payload));
        _rx.Enqueue(Message(canId, payload, TxMsgType)); // TX echo/indication
        var responseCanId = canId switch
        {
            0x743 => 0x763u,
            0x745 => 0x765u,
            _ => canId + 8,
        };
        foreach (var response in Responder(canId, payload))
        {
            if (response.Length > 7) _rx.Enqueue(Message(responseCanId, [], Iso15765FirstFrame));
            _rx.Enqueue(Message(responseCanId, response, 0));
        }
        return 0;
    }

    int Read(uint channelId, IntPtr pMsg, ref uint count, uint timeout)
    {
        if (_rx.Count == 0) { count = 0; return J2534Status.ERR_BUFFER_EMPTY; }
        Marshal.StructureToPtr(_rx.Dequeue(), pMsg, false);
        count = 1;
        return 0;
    }

    static PassThruMsg Message(uint canId, byte[] payload, uint rxStatus)
    {
        var msg = PassThruMsgHelper.Create(PassThruApi.PROTOCOL_ISO15765, canId, payload);
        msg.RxStatus = rxStatus;
        return msg;
    }

    public bool SentService(byte service, uint? canId = null) =>
        AddressedRequests.Any(r => r.Payload.Length > 0 && r.Payload[0] == service && (!canId.HasValue || r.CanId == canId));
}

public sealed class ObdOverMockedJ2534Tests
{
    const string Vin = "2C3CDXBG5MH000001";
    static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    static ObdOverMockedJ2534Tests()
    {
        Environment.SetEnvironmentVariable("SHOP_CRANK_J2534_TOKEN", "test-host-token");
    }

    static IEnumerable<byte[]> Car(uint canId, byte[] request)
    {
        var key = Convert.ToHexString(request);
        return key switch
        {
            "3E00" => [[0x7E, 0x00]],
            "0902" => [[0x49, 0x02, 0x01, .. Encoding.ASCII.GetBytes(Vin)]],
            "0100" => [[0x41, 0x00, 0x88, 0x18, 0x00, 0x00]], // 01, 05, 0C, 0D
            "0101" => [[0x41, 0x01, 0x82, 0x07, 0x65, 0x00]],
            "0105" => [[0x41, 0x05, 0x7B]],
            "010C" => [[0x7F, 0x01, 0x78], [0x41, 0x0C, 0x0B, 0xB8]], // response pending, then 750 rpm
            "010D" => [[0x41, 0x0D, 0x00]],
            "03" => [[0x43, 0x02, 0x04, 0x20, 0xC1, 0x00]],
            "07" => [[0x47, 0x00]],
            "0A" => [[0x7F, 0x0A, 0x11]],
            "04" => [[0x44]],
            _ => [[0x7F, request[0], 0x11]],
        };
    }

    static (DiagnosticSession Session, FakeJ2534Dll Dll) Connect()
    {
        var dll = new FakeJ2534Dll { Responder = Car };
        var session = new DiagnosticSession();
        var device = PassThruDevice.Open(dll.CreateLibrary(), "PassThru464.dll", "Mock RLink");
        session.AttachDevice(device, "registry-native-0404-topdon---rlink", "RLink", "PassThru464.dll");
        return (session, dll);
    }

    static JsonElement Json(object value) => JsonSerializer.SerializeToElement(value, Camel);

    static Task<JsonRpcResponse> Call(DiagnosticSession session, string method, object? extra = null)
    {
        var values = new Dictionary<string, object?> { ["authToken"] = "test-host-token" };
        if (extra is not null)
        {
            foreach (var property in JsonSerializer.SerializeToElement(extra).EnumerateObject())
                values[property.Name] = property.Value.Clone();
        }
        return RpcDispatcher.DispatchAsync(new JsonRpcRequest { Id = method, Method = method, Params = JsonSerializer.SerializeToElement(values) }, session);
    }

    [Fact]
    public void ConnectsOverIso15765AndReadsBatteryVoltage()
    {
        var (session, dll) = Connect();
        Assert.Equal(PassThruApi.PROTOCOL_ISO15765, dll.Protocol);
        Assert.Equal(500_000u, dll.Baud);
        var status = Json(session.GetConnectionStatus());
        Assert.True(status.GetProperty("connected").GetBoolean());
        Assert.False(status.GetProperty("simulator").GetBoolean());
        Assert.Equal(12.5, status.GetProperty("voltage").GetDouble());
    }

    [Fact]
    public async Task SnapshotReadsVinPidsAndCodesFromTheVehicle()
    {
        var (session, _) = Connect();
        var response = await Call(session, "obdSnapshot");
        Assert.Null(response.Error);
        var snapshot = Json(response.Result!);
        Assert.Equal("live", snapshot.GetProperty("source").GetString());
        Assert.Equal(Vin, snapshot.GetProperty("vin").GetString());
        Assert.True(snapshot.GetProperty("milOn").GetBoolean());
        Assert.Equal(2, snapshot.GetProperty("reportedDtcCount").GetInt32());
        var readings = snapshot.GetProperty("readings").EnumerateArray().ToDictionary(r => r.GetProperty("pid").GetString()!, r => r.GetProperty("value").GetDouble());
        Assert.Equal(83, readings["0x05"]);
        Assert.Equal(750, readings["0x0C"]);
        Assert.Equal(0, readings["0x0D"]);
        Assert.Equal(["P0420", "U0100"], snapshot.GetProperty("storedDtcs").EnumerateArray().Select(x => x.GetString()!).ToArray());
        Assert.Empty(snapshot.GetProperty("pendingDtcs").EnumerateArray());
        Assert.Empty(snapshot.GetProperty("permanentDtcs").EnumerateArray());
        Assert.Empty(snapshot.GetProperty("errors").EnumerateArray());
    }

    [Fact]
    public async Task ClearingCodesNeedsExplicitConfirmation()
    {
        var (session, dll) = Connect();
        var refused = await Call(session, "obdClearDtcs");
        Assert.Contains("Confirm", refused.Error?.Message);
        Assert.False(dll.SentService(0x04));

        var cleared = await Call(session, "obdClearDtcs", new { confirmed = true });
        Assert.Null(cleared.Error);
        Assert.True(dll.SentService(0x04));
        Assert.True(Json(cleared.Result!).GetProperty("cleared").GetBoolean());
    }

    [Fact]
    public async Task LiveKeyProgrammingIsRefusedWithoutAVerifiedProcedureAndWritesNothing()
    {
        var (session, dll) = Connect();
        // Opt out of the shipped Stellantis catalog so unsupported platforms stay fail-closed.
        session.KeyCatalog = KeyProcedureCatalog.Default;
        var support = await Call(session, "keyProcedureSupport", new { procedure = "add_key" });
        Assert.Null(support.Error);
        var supportJson = Json(support.Result!);
        Assert.False(supportJson.GetProperty("supported").GetBoolean());
        Assert.Equal(Vin, supportJson.GetProperty("vin").GetString());

        var attempt = await Call(session, "addKey", new { pin = "1234" });
        Assert.Contains("does not have a verified live add key procedure", attempt.Error?.Message);
        foreach (var write in new byte[] { 0x10, 0x27, 0x2E, 0x31, 0x34, 0x36 })
            Assert.False(dll.SentService(write), $"service 0x{write:X2} must not be sent");
    }

    [Fact]
    public async Task StellantisLiveCatalogReportsAddKeySupportedForCoveredWmi()
    {
        var (session, _) = Connect();
        var support = await Call(session, "keyProcedureSupport", new { procedure = "add_key" });
        Assert.Null(support.Error);
        var supportJson = Json(support.Result!);
        Assert.True(supportJson.GetProperty("supported").GetBoolean());
        Assert.Equal(Vin, supportJson.GetProperty("vin").GetString());
        Assert.False(supportJson.GetProperty("requiresVehiclePin").GetBoolean());
    }

    [Fact]
    public async Task VerifiedProcedureStopsWhenTheVehicleAsksForAPin()
    {
        var (session, dll) = Connect();
        var executed = 0;
        session.KeyCatalog = new KeyProcedureCatalog([
            new KeyProcedureDefinition
            {
                Procedure = "add_key", Wmis = ["2C3"], RequiresVehiclePin = true, Description = "test",
                Execute = context => { executed++; Assert.Equal("4321", context.Pin); return new { completed = true }; },
            },
        ]);
        await Assert.ThrowsAsync<InvalidOperationException>(() => session.ProgramKeyAsync("add_key", Vin, null));
        Assert.Equal(0, executed);

        // Live programming requires an open immobilizer SecurityAccess session first.
        session.SecurityAccessProviderOverride = new SimulatorSecurityAccessProvider();
        dll.Responder = (_, request) => request switch
        {
            [0x10, 0x02] => [[0x50, 0x02]],
            [0x27, 0x03] => [[0x67, 0x03, 0xA1, 0xB2, 0xC3, 0xD4]],
            [0x27, 0x04, ..] => [[0x67, 0x04]],
            _ => Car(_, request),
        };
        await session.SecurityAccessAsync("immobilizer");
        await session.ProgramKeyAsync("add_key", Vin, "4321");
        Assert.Equal(1, executed);
    }

    [Fact]
    public async Task SimulatorSnapshotIsLabelledSimulator()
    {
        using var session = new DiagnosticSession();
        session.Connect(new ConnectParams { AdapterId = "simulator" });
        var response = await Call(session, "obdSnapshot");
        Assert.Null(response.Error);
        var snapshot = Json(response.Result!);
        Assert.Equal("simulator", snapshot.GetProperty("source").GetString());
        Assert.Equal("1C6SRFHT0LN123456", snapshot.GetProperty("vin").GetString());
        Assert.Equal(["P0456"], snapshot.GetProperty("storedDtcs").EnumerateArray().Select(x => x.GetString()!).ToArray());
    }

    [Theory]
    [InlineData((byte)0x04, (byte)0x20, "P0420")]
    [InlineData((byte)0xC1, (byte)0x00, "U0100")]
    [InlineData((byte)0x41, (byte)0x23, "C0123")]
    [InlineData((byte)0x93, (byte)0x45, "B1345")]
    public void FormatsTroubleCodes(byte a, byte b, string expected) => Assert.Equal(expected, ObdClient.FormatDtc(a, b));

    [Fact]
    public void ThirtyTwoBitDriversAreNotLoadableFromTheSixtyFourBitHost()
    {
        Assert.True(AdapterRegistry.HostCanLoad("64", hostIs64Bit: true));
        Assert.False(AdapterRegistry.HostCanLoad("32", hostIs64Bit: true));
        Assert.Equal("32", AdapterRegistry.BitnessForRoot(@"SOFTWARE\WOW6432Node\PassThruSupport.04.04"));
        Assert.Equal("32", AdapterRegistry.BitnessForRoot(@"registry32:SOFTWARE\PassThruSupport.04.04"));
        Assert.Equal("64", AdapterRegistry.BitnessForRoot(@"SOFTWARE\PassThruSupport.04.04"));
    }

    [Fact]
    public void ResponseIdIsRequestPlusEight()
    {
        Assert.Equal("0x7E8", DiagnosticSession.ResponseId("0x7E0"));
        Assert.Equal("0x7E9", DiagnosticSession.ResponseId("0x7E1"));
        Assert.Equal("0x7EC", DiagnosticSession.ResponseId("0x7E4"));
    }

    const string MaximaVin = "1N4AA6AP1GC123456";

    [Fact]
    public void NissanMaximaLiveAddKeyIsInTheShippedCatalog()
    {
        Assert.True(NissanKeyProcedures.IsMaxima(MaximaVin));
        Assert.False(NissanKeyProcedures.IsMaxima("1N4AL3AP1GC123456"));
        var support = KeyProcedureCatalog.LiveVerified.Evaluate("add_key", MaximaVin, simulator: false);
        Assert.True(support.Supported);
        Assert.True(support.RequiresVehiclePin);
        Assert.False(KeyProcedureCatalog.LiveVerified.Evaluate("add_key", "1N4AL3AP1GC123456", simulator: false).Supported);
        var identity = VehicleIdentity.FromVin(MaximaVin);
        Assert.Equal("Nissan", identity.Make);
        Assert.Equal("Maxima", identity.Model);
        Assert.Equal("A36", identity.Platform);
        Assert.Equal(2016, identity.Year);
        Assert.NotEqual("Stellantis", identity.Make);
        Assert.True(KeyProcedureCatalog.LiveVerified.Evaluate("add_key", Vin, simulator: false).Supported);
    }

    static IEnumerable<byte[]> NissanCar(uint canId, byte[] request)
    {
        var key = Convert.ToHexString(request);
        if (canId == 0x7E0 && key == "0902")
            return [[0x49, 0x02, 0x01, .. Encoding.ASCII.GetBytes(MaximaVin)]];
        if (canId == 0x7E0 && key == "22F190")
            return [[0x62, 0xF1, 0x90, .. Encoding.ASCII.GetBytes(MaximaVin)]];
        if (canId != 0x743) return [[0x7F, request[0], 0x11]];
        if (key == "0902") return [[0x49, 0x02, 0x01, .. Encoding.ASCII.GetBytes(MaximaVin)]];
        if (key == "22F190") return [[0x62, 0xF1, 0x90, .. Encoding.ASCII.GetBytes(MaximaVin)]];
        if (key == "3E00") return [[0x7E, 0x00]];
        if (request.Length == 3 && request[0] == 0x22)
            return [[0x62, request[1], request[2], .. Encoding.ASCII.GetBytes("BCM")]];
        if (key == "1003") return [[0x50, 0x03]];
        if (key == "2701") return [[0x67, 0x01, 0xAA, 0xBB, 0xCC, 0xDD]];
        if (key == "270231323334") return [[0x67, 0x02]];
        if (key.StartsWith("31010202", StringComparison.Ordinal)) return [[0x71, 0x01, 0x02, 0x02]];
        return [[0x7F, request[0], 0x11]];
    }

    [Fact]
    public async Task NissanMaximaAddKeySendsSessionSecurityAndRegisterRoutine()
    {
        var dll = new FakeJ2534Dll { Responder = NissanCar };
        var session = new DiagnosticSession();
        var device = PassThruDevice.Open(dll.CreateLibrary(), "PassThru464.dll", "Mock RLink");
        session.AttachDevice(device, "registry-native-0404-topdon---rlink", "RLink", "PassThru464.dll");

        var support = await session.KeyProcedureSupportAsync("add_key");
        Assert.True(support.Supported);
        Assert.True(support.RequiresVehiclePin);
        Assert.Equal(MaximaVin, support.Vin);
        var ecus = Json(await session.IdentifyEcusAsync()).GetProperty("ecus").EnumerateArray().ToArray();
        Assert.Equal("BCM", ecus.Single(e => e.GetProperty("logicalAddress").GetString() == "0x743").GetProperty("partNumber").GetString());

        await Assert.ThrowsAsync<InvalidOperationException>(() => session.ProgramKeyAsync("add_key", MaximaVin, null));
        Assert.False(dll.SentService(0x10));
        Assert.False(dll.SentService(0x27));
        Assert.False(dll.SentService(0x31));

        var unlocked = Json(await session.SecurityAccessAsync("immobilizer"));
        Assert.True(unlocked.GetProperty("unlocked").GetBoolean());
        Assert.Equal("vehicle-pin", unlocked.GetProperty("deferred").GetString());
        Assert.False(dll.SentService(0x27));

        var result = Json(await session.ProgramKeyAsync("add_key", MaximaVin, "1234"));
        Assert.True(result.GetProperty("completed").GetBoolean());
        Assert.Equal("0x743", result.GetProperty("ecu").GetString());
        Assert.Equal("BCM", result.GetProperty("ecuName").GetString());
        Assert.True(dll.SentService(0x10));
        Assert.True(dll.SentService(0x27));
        Assert.True(dll.SentService(0x31));
        Assert.True(dll.SentService(0x31, 0x743));
        Assert.False(dll.SentService(0x31, 0x7E0));

        var entries = Json(session.PollLiveLog(0)).GetProperty("entries").EnumerateArray().ToArray();
        var unredactedCredentials = entries
            .Select(entry => entry.GetProperty("data").GetString()!)
            .Where(data => data.Contains("270231323334", StringComparison.Ordinal)
                || data.Contains("3101020231323334", StringComparison.Ordinal))
            .ToArray();
        Assert.Empty(unredactedCredentials);
        Assert.Contains(entries, entry => entry.GetProperty("data").GetString() == "2702[REDACTED]");
        Assert.Contains(entries, entry => entry.GetProperty("data").GetString() == "31010202[REDACTED]");
    }

    [Fact]
    public async Task NissanMaximaDoesNotTryAnotherModuleAfterSecurityAccessFails()
    {
        var dll = new FakeJ2534Dll
        {
            Responder = (canId, request) =>
            {
                var key = Convert.ToHexString(request);
                if (canId == 0x743 && key == "2701") return [[0x7F, 0x27, 0x35]];
                if (canId == 0x745 && request.Length == 3 && request[0] == 0x22)
                    return [[0x62, request[1], request[2], .. Encoding.ASCII.GetBytes("Intelligent Key")]];
                if (canId == 0x745 && key == "1003") return [[0x50, 0x03]];
                if (canId == 0x745 && key == "2701") return [[0x67, 0x01, 0xAA, 0xBB, 0xCC, 0xDD]];
                if (canId == 0x745 && key == "270231323334") return [[0x67, 0x02]];
                if (canId == 0x745 && key.StartsWith("31010202", StringComparison.Ordinal))
                    return [[0x71, 0x01, 0x02, 0x02]];
                return NissanCar(canId, request);
            },
        };
        var session = new DiagnosticSession();
        var device = PassThruDevice.Open(dll.CreateLibrary(), "PassThru464.dll", "Mock RLink");
        session.AttachDevice(device, "registry-native-0404-topdon---rlink", "RLink", "PassThru464.dll");
        await session.SecurityAccessAsync("immobilizer");

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            session.ProgramKeyAsync("add_key", MaximaVin, "1234"));

        Assert.Contains("no registration routine was sent", ex.Message);
        Assert.Contains(dll.AddressedRequests, r => r.CanId == 0x743 && r.Payload.SequenceEqual(new byte[] { 0x27, 0x01 }));
        Assert.DoesNotContain(dll.AddressedRequests, r => r.CanId == 0x745 && r.Payload[0] is 0x10 or 0x27 or 0x31);
    }

    [Fact]
    public async Task NissanMaximaDoesNotRetryRegistrationOnAnotherModuleAfterAnUncertainResult()
    {
        var dll = new FakeJ2534Dll
        {
            Responder = (canId, request) =>
            {
                if (canId == 0x743 && request[0] == 0x31) return [[0x7F, 0x31, 0x22]];
                return canId == 0x745 ? NissanCar(0x743, request) : NissanCar(canId, request);
            },
        };
        var session = new DiagnosticSession();
        var device = PassThruDevice.Open(dll.CreateLibrary(), "PassThru464.dll", "Mock RLink");
        session.AttachDevice(device, "registry-native-0404-topdon---rlink", "RLink", "PassThru464.dll");
        await session.SecurityAccessAsync("immobilizer");

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            session.ProgramKeyAsync("add_key", MaximaVin, "1234"));

        Assert.Contains("result is indeterminate", ex.Message);
        Assert.Contains(dll.AddressedRequests, r => r.CanId == 0x743 && r.Payload[0] == 0x31);
        Assert.DoesNotContain(dll.AddressedRequests, r => r.CanId == 0x745 && r.Payload[0] is 0x10 or 0x27 or 0x31);
    }

    [Fact]
    public async Task NissanMaximaDoesNotSendAnUnsupportedSecurityKey()
    {
        var dll = new FakeJ2534Dll { Responder = NissanCar };
        var session = new DiagnosticSession();
        var device = PassThruDevice.Open(dll.CreateLibrary(), "PassThru464.dll", "Mock RLink");
        session.AttachDevice(device, "registry-native-0404-topdon---rlink", "RLink", "PassThru464.dll");
        await session.SecurityAccessAsync("immobilizer");

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            session.ProgramKeyAsync("add_key", MaximaVin, "123456"));

        Assert.Contains(dll.AddressedRequests, r => r.CanId == 0x743 && r.Payload.SequenceEqual(new byte[] { 0x27, 0x01 }));
        Assert.DoesNotContain(dll.AddressedRequests, r => r.Payload.Length > 1 && r.Payload[0] == 0x27 && r.Payload[1] == 0x02);
        Assert.False(dll.SentService(0x31));
    }

    [Theory]
    [InlineData("1234", 2, "1234")]
    [InlineData("1234", 4, "31323334")]
    public void PinSecurityAccessUsesOnlySupportedExactLengthEncodings(string pin, int seedLength, string expectedHex)
    {
        var key = new PinSecurityAccessProvider(pin).ComputeKey(1, new byte[seedLength], MaximaVin);
        Assert.Equal(expectedHex, Convert.ToHexString(key));
    }

    [Theory]
    [InlineData("123456", 2)]
    [InlineData("123456", 4)]
    [InlineData("1234", 3)]
    public void PinSecurityAccessRejectsUnverifiedPinAndSeedCombinations(string pin, int seedLength)
    {
        var ex = Assert.Throws<InvalidOperationException>(() =>
            new PinSecurityAccessProvider(pin).ComputeKey(1, new byte[seedLength], MaximaVin));
        Assert.Contains("no verified encoding", ex.Message);
    }
}
