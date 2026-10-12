using System.Text.Json;
using MechPro.J2534.Core;

namespace MechPro.J2534.Host;

public static class RpcDispatcher
{
    static readonly string? HostToken = Environment.GetEnvironmentVariable("MECHPRO_J2534_TOKEN");

    public static async Task<JsonRpcResponse> DispatchAsync(JsonRpcRequest request, DiagnosticSession session)
    {
        try
        {
            AssertAuth(request.Params);
            var result = request.Method switch
            {
                "ping" => new { ok = true, simulator = session.IsSimulator },
                "listAdapters" => AdapterRegistry.ListAdapters(),
                "connect" => session.Connect(ParseConnect(request.Params)),
                "disconnect" => session.Disconnect(),
                "getConnectionStatus" => session.GetConnectionStatus(),
                "readVin" => await session.ReadVinAsync(),
                "identifyEcus" => await session.IdentifyEcusAsync(),
                "readDtcs" => await session.ReadDtcsAsync(),
                "clearDtcs" => await ClearDtcs(request.Params, session),
                "securityAccess" => await session.SecurityAccessAsync(GetString(request.Params, "scope") ?? "immobilizer"),
                "addKey" => await ProgramKey("add_key", request.Params, session),
                "programKey" => await ProgramKey("add_key", request.Params, session),
                "allKeysLost" => await ProgramKey("all_keys_lost", request.Params, session),
                "programRemote" => await ProgramKey("program_remote", request.Params, session),
                "eraseKeys" => await ProgramKey("erase_keys", request.Params, session),
                "flashModule" => await FlashModule(request.Params, session),
                "codeModule" => await CodeModule(request.Params, session),
                "bidirectionalControl" => await Bidirectional(request.Params, session),
                "startLiveLog" => session.StartLiveLog(),
                "stopLiveLog" => session.StopLiveLog(),
                "pollLiveLog" => session.PollLiveLog(ParseSince(request.Params)),
                "identifyVehicle" => await session.IdentifyVehicleAsync(),
                "obdSnapshot" => session.ObdSnapshot(),
                "obdClearDtcs" => session.ObdClearDtcs(GetBool(request.Params, "confirmed")),
                "keyProcedureSupport" => await session.KeyProcedureSupportAsync(GetString(request.Params, "procedure") ?? ""),
                _ => throw new InvalidOperationException($"Unknown method: {request.Method}"),
            };
            return JsonRpcResponse.Ok(request.Id, result);
        }
        catch (Exception ex)
        {
            return JsonRpcResponse.Fail(request.Id, -32000, ex.Message);
        }
    }

    // Tokens are scoped to a mode: the simulator accepts SIMULATE tokens; real
    // hardware requires LIVE tokens (and a licensed AutoAuth security provider).
    static string ExpectedMode(DiagnosticSession session) => session.IsSimulator ? "simulate" : "live";

    static async Task<CapabilityToken.Payload> VerifyForConnectedVehicle(
        string? token,
        string procedure,
        DiagnosticSession session)
    {
        var vin = await session.ReadConnectedVinAsync();
        return CapabilityToken.Verify(token, procedure, ExpectedMode(session), vin);
    }

    static async Task<object> ClearDtcs(JsonElement? element, DiagnosticSession session)
    {
        await VerifyForConnectedVehicle(GetString(element, "authorizationToken"), "clear_dtcs", session);
        return await session.ClearDtcsAsync();
    }

    static async Task<object> ProgramKey(string procedure, JsonElement? element, DiagnosticSession session)
    {
        if (!session.IsSimulator)
        {
            // Refuse before any token or bus work when no verified live procedure exists.
            var support = await session.KeyProcedureSupportAsync(procedure);
            if (!support.Supported) throw new NotSupportedException(support.Reason);
        }
        var payload = await VerifyForConnectedVehicle(GetString(element, "authorizationToken"), procedure, session);
        return await session.ProgramKeyAsync(procedure, payload.Vin, GetString(element, "pin"));
    }

    static async Task<object> FlashModule(JsonElement? element, DiagnosticSession session)
    {
        var payload = await VerifyForConnectedVehicle(GetString(element, "authorizationToken"), "module_flash", session);
        var target = GetString(element, "target") ?? "0x7E1";
        var firmware = ReadFirmware(element);
        var version = GetFirmwareVersion(element) ?? $"live-{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        return await session.FlashModuleAsync(target, firmware, version, payload.Vin);
    }

    static async Task<object> CodeModule(JsonElement? element, DiagnosticSession session)
    {
        var payload = await VerifyForConnectedVehicle(GetString(element, "authorizationToken"), "module_coding", session);
        var target = GetString(element, "target") ?? "0x7E0";
        var didText = (GetString(element, "did") ?? "").Trim();
        if (didText.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) didText = didText[2..];
        if (!ushort.TryParse(didText, System.Globalization.NumberStyles.HexNumber, null, out var did))
            throw new InvalidOperationException("Coding identifier must be a 4-digit hex DID");
        var dataText = (GetString(element, "data") ?? "").Replace(" ", "").Trim();
        if (dataText.Length is < 2 or > 128 || dataText.Length % 2 != 0)
            throw new InvalidOperationException("Coding data must be even-length hex, up to 64 bytes");
        var data = Convert.FromHexString(dataText);
        return await session.CodeModuleAsync(target, did, data, payload.Vin);
    }

    static async Task<object> Bidirectional(JsonElement? element, DiagnosticSession session)
    {
        var payload = await VerifyForConnectedVehicle(GetString(element, "authorizationToken"), "bidirectional_control", session);
        var control = GetString(element, "control") ?? "";
        var state = GetString(element, "state") ?? "on";
        return await session.BidirectionalControlAsync(control, state, payload.Vin);
    }

    static byte[] ReadFirmware(JsonElement? element)
    {
        if (element is not null && element.Value.TryGetProperty("firmware", out var fw))
        {
            if (fw.TryGetProperty("data", out var data) && data.GetString() is { Length: > 0 } b64)
            {
                return Convert.FromBase64String(b64);
            }
            if (fw.TryGetProperty("size", out var size) && size.TryGetInt32(out var n) && n > 0)
            {
                return new byte[n];
            }
        }
        throw new InvalidOperationException("Firmware payload (data or size) is required for module flash");
    }

    static string? GetFirmwareVersion(JsonElement? element)
    {
        if (element is not null && element.Value.TryGetProperty("firmware", out var fw)
            && fw.TryGetProperty("version", out var v))
        {
            return v.GetString();
        }
        return null;
    }

    static string? GetString(JsonElement? element, string name)
    {
        if (element is not null && element.Value.TryGetProperty(name, out var value))
        {
            return value.GetString();
        }
        return null;
    }

    static bool GetBool(JsonElement? element, string name) =>
        element is not null
        && element.Value.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.True;

    static void AssertAuth(JsonElement? element)
    {
        // Fail closed unless explicitly opted into unauthenticated local/dev hosts.
        if (string.IsNullOrEmpty(HostToken))
        {
            if (Environment.GetEnvironmentVariable("MECHPRO_ALLOW_UNAUTHENTICATED_HOST") == "1") return;
            throw new UnauthorizedAccessException("Unauthorized J2534 RPC — host token not configured");
        }
        if (element is null || !element.Value.TryGetProperty("authToken", out var token)
            || token.GetString() != HostToken)
        {
            throw new UnauthorizedAccessException("Unauthorized J2534 RPC — invalid host token");
        }
    }

    static ConnectParams ParseConnect(JsonElement? element)
    {
        if (element is null) return new ConnectParams();
        return JsonSerializer.Deserialize<ConnectParams>(element.Value.GetRawText(), JsonOptions.Rpc) ?? new ConnectParams();
    }

    static long ParseSince(JsonElement? element)
    {
        if (element is null || !element.Value.TryGetProperty("since", out var since)) return 0;
        return since.GetInt64();
    }
}
