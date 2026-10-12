using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using MechPro.J2534.Core;
using MechPro.J2534.Native;
using MechPro.J2534.Uds;
using Xunit;

namespace MechPro.J2534.Host.Tests;

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
    public List<byte[]> Requests { get; } = [];
    public uint Protocol { get; private set; }
    public uint Baud { get; private set; }
    public Func<byte[], IEnumerable<byte[]>> Responder { get; set; } = request => [[0x7F, request[0], 0x11]];

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
        Requests.Add(payload);
        _rx.Enqueue(Message(canId, payload, TxMsgType)); // TX echo/indication
        foreach (var response in Responder(payload))
        {
            if (response.Length > 7) _rx.Enqueue(Message(canId + 8, [], Iso15765FirstFrame));
            _rx.Enqueue(Message(canId + 8, response, 0));
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

    public bool SentService(byte service) => Requests.Any(r => r.Length > 0 && r[0] == service);
}

public sealed class ObdOverMockedJ2534Tests
{
    const string Vin = "2C3CDXBG5MH000001";
    static readonly JsonSerializerOptions Camel = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    static ObdOverMockedJ2534Tests()
    {
        Environment.SetEnvironmentVariable("MECHPRO_J2534_TOKEN", "test-host-token");
    }

    static IEnumerable<byte[]> Car(byte[] request)
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
        await session.ProgramKeyAsync("add_key", Vin, "4321");
        Assert.Equal(1, executed);
        Assert.False(dll.SentService(0x27));
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
}
