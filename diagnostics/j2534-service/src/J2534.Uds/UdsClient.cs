using System.Linq;
using ShopCrank.J2534.IsoTp;

namespace ShopCrank.J2534.Uds;

public sealed class EcuIdentification
{
    public string PartNumber { get; set; } = "";
    public string SoftwareVersion { get; set; } = "";
    public string CalibrationId { get; set; } = "";
}

/// <summary>UDS diagnostic services for vehicle identification and DTC operations.</summary>
public sealed class UdsClient
{
    readonly IIsoTpChannel _channel;

    public UdsClient(IIsoTpChannel channel) => _channel = channel;

    public Task<string> ReadVinAsync(string txId, string rxId)
    {
        var response = _channel.SendRequest([0x22, 0xF1, 0x90], txId, rxId);
        ValidatePositive(response, 0x62);
        var vinBytes = response.AsSpan(3);
        return Task.FromResult(System.Text.Encoding.ASCII.GetString(vinBytes).Trim('\0', ' '));
    }

    public Task SendTesterPresent(string txId, string rxId)
    {
        _channel.SendRequest([0x3E, 0x00], txId, rxId);
        return Task.CompletedTask;
    }

    public Task<EcuIdentification> ReadEcuIdentificationAsync(string txId, string rxId)
    {
        var part = ReadDataById([0x22, 0xF1, 0x8A], txId, rxId);
        var sw = ReadDataById([0x22, 0xF1, 0x89], txId, rxId);
        var cal = ReadDataById([0x22, 0xF1, 0x8C], txId, rxId);
        return Task.FromResult(new EcuIdentification
        {
            PartNumber = part,
            SoftwareVersion = sw,
            CalibrationId = cal,
        });
    }

    public Task<object[]> ReadDtcsAsync(string txId, string rxId)
    {
        var response = _channel.SendRequest([0x19, 0x02, 0xFF], txId, rxId);
        ValidatePositive(response, 0x59);
        return Task.FromResult(ParseDtcs(response));
    }

    public Task ClearDtcsAsync(string txId, string rxId)
    {
        var response = _channel.SendRequest([0x14, 0xFF, 0xFF, 0xFF], txId, rxId);
        ValidatePositive(response, 0x54);
        return Task.CompletedTask;
    }

    /// <summary>Enter a diagnostic/programming session (UDS 0x10).</summary>
    public void DiagnosticSessionControl(byte sessionType, string txId, string rxId)
    {
        var response = _channel.SendRequest([0x10, sessionType], txId, rxId);
        ValidatePositive(response, 0x50);
    }

    /// <summary>
    /// UDS SecurityAccess (0x27): request the seed at <paramref name="level"/>
    /// (odd sub-function), compute the key via the supplied provider, and send
    /// it (even sub-function). Throws on a negative response or refused unlock.
    /// </summary>
    public void SecurityAccess(int level, ISecurityAccessProvider provider, string vin, string txId, string rxId)
    {
        var seedResponse = _channel.SendRequest([0x27, (byte)level], txId, rxId);
        ValidatePositive(seedResponse, 0x67);
        var seed = seedResponse.AsSpan(2).ToArray();
        if (seed.All(b => b == 0)) return; // already unlocked
        var key = provider.ComputeKey(level, seed, vin);
        var request = new byte[2 + key.Length];
        request[0] = 0x27;
        request[1] = (byte)(level + 1);
        Array.Copy(key, 0, request, 2, key.Length);
        var keyResponse = _channel.SendRequest(request, txId, rxId);
        ValidatePositive(keyResponse, 0x67);
    }

    /// <summary>Start a RoutineControl (0x31 0x01) routine and return the raw response.</summary>
    public byte[] StartRoutine(ushort routineId, byte[] parameters, string txId, string rxId)
    {
        var request = new byte[4 + parameters.Length];
        request[0] = 0x31;
        request[1] = 0x01;
        request[2] = (byte)(routineId >> 8);
        request[3] = (byte)(routineId & 0xFF);
        Array.Copy(parameters, 0, request, 4, parameters.Length);
        var response = _channel.SendRequest(request, txId, rxId);
        ValidatePositive(response, 0x71);
        return response;
    }

    /// <summary>InputOutputControlByIdentifier (0x2F) for a named actuator test.</summary>
    public void InputOutputControl(ushort did, byte option, string txId, string rxId)
    {
        var response = _channel.SendRequest([0x2F, (byte)(did >> 8), (byte)(did & 0xFF), option], txId, rxId);
        ValidatePositive(response, 0x6F);
    }

    /// <summary>WriteDataByIdentifier (0x2E).</summary>
    public void WriteDataByIdentifier(ushort did, byte[] data, string txId, string rxId)
    {
        var request = new byte[3 + data.Length];
        request[0] = 0x2E;
        request[1] = (byte)(did >> 8);
        request[2] = (byte)(did & 0xFF);
        Array.Copy(data, 0, request, 3, data.Length);
        var response = _channel.SendRequest(request, txId, rxId);
        ValidatePositive(response, 0x6E);
    }

    /// <summary>
    /// Reflash a module using the UDS programming sequence: RequestDownload
    /// (0x34) → TransferData (0x36) blocks → RequestTransferExit (0x37).
    /// Invokes <paramref name="onProgress"/> after each accepted block.
    /// </summary>
    public void DownloadFirmware(byte[] firmware, string txId, string rxId, Action<int, int>? onProgress = null)
    {
        // RequestDownload: dataFormatId=0x00, addressAndLengthFormatId=0x44 (4-byte addr + 4-byte size).
        var size = firmware.Length;
        var request = new byte[]
        {
            0x34, 0x00, 0x44,
            0x00, 0x00, 0x00, 0x00,
            (byte)(size >> 24), (byte)(size >> 16), (byte)(size >> 8), (byte)size,
        };
        var response = _channel.SendRequest(request, txId, rxId);
        ValidatePositive(response, 0x74);

        const int blockSize = 0x400;
        var blocks = (size + blockSize - 1) / blockSize;
        for (var index = 0; index < blocks; index++)
        {
            var offset = index * blockSize;
            var length = Math.Min(blockSize, size - offset);
            var block = new byte[2 + length];
            block[0] = 0x36;
            block[1] = (byte)((index + 1) & 0xFF);
            Array.Copy(firmware, offset, block, 2, length);
            var blockResponse = _channel.SendRequest(block, txId, rxId);
            ValidatePositive(blockResponse, 0x76);
            onProgress?.Invoke(index + 1, blocks);
        }

        var exit = _channel.SendRequest([0x37], txId, rxId);
        ValidatePositive(exit, 0x77);
    }

    string ReadDataById(byte[] request, string txId, string rxId)
    {
        var response = _channel.SendRequest(request, txId, rxId);
        ValidatePositive(response, 0x62);
        return System.Text.Encoding.ASCII.GetString(response.AsSpan(3)).Trim('\0', ' ');
    }

    static object[] ParseDtcs(byte[] response)
    {
        if (response.Length <= 3) return [];
        var dtcs = new List<object>();
        for (var i = 3; i + 3 < response.Length; i += 4)
        {
            var a = response[i];
            var b = response[i + 1];
            var c = response[i + 2];
            var status = response[i + 3];
            var prefix = ((a & 0xC0) >> 6) switch { 0 => "P", 1 => "C", 2 => "B", _ => "U" };
            var code = $"{prefix}{((a & 0x3F) << 8) | b:X4}";
            dtcs.Add(new { code, status = StatusLabel(status), description = $"DTC {code}" });
        }
        return dtcs.ToArray();
    }

    static string StatusLabel(byte status) => status switch
    {
        0x08 => "pending",
        0x09 => "pending",
        0x0A => "permanent",
        _ => "stored",
    };

    static void ValidatePositive(byte[] response, byte expectedSid)
    {
        if (response.Length < 1 || response[0] != expectedSid)
        {
            var nrc = response.Length >= 3 && response[0] == 0x7F ? response[2] : (byte)0xFF;
            throw new InvalidOperationException($"UDS negative response NRC 0x{nrc:X2}");
        }
    }
}
