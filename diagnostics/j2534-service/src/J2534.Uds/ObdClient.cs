using System.Text;
using MechPro.J2534.IsoTp;

namespace MechPro.J2534.Uds;

/// <summary>One decoded SAE J1979 mode 01 reading.</summary>
public sealed class ObdPidReading
{
    public string Pid { get; init; } = "";
    public string Name { get; init; } = "";
    public double? Value { get; init; }
    public string Unit { get; init; } = "";
    public string Raw { get; init; } = "";
}

/// <summary>Mode 01 PID 01: MIL lamp and stored-code count.</summary>
public sealed class ObdMonitorStatus
{
    public bool MilOn { get; init; }
    public int DtcCount { get; init; }
    public string Raw { get; init; } = "";
}

/// <summary>Negative response from an emissions ECU (0x7F service NRC).</summary>
public sealed class ObdNegativeResponseException : InvalidOperationException
{
    public byte Service { get; }
    public byte Nrc { get; }

    public ObdNegativeResponseException(byte service, byte nrc)
        : base($"ECU refused OBD service 0x{service:X2} (NRC 0x{nrc:X2}: {Describe(nrc)})")
    {
        Service = service;
        Nrc = nrc;
    }

    static string Describe(byte nrc) => nrc switch
    {
        0x11 => "service not supported",
        0x12 => "sub-function not supported",
        0x22 => "conditions not correct - ignition on, engine off",
        0x31 => "request out of range",
        _ => "refused",
    };
}

/// <summary>
/// Generic OBD-II (SAE J1979) over ISO 15765-4 CAN, addressed physically to the
/// engine ECU (0x7E0 to 0x7E8). It covers 11-bit CAN, which every US vehicle
/// has used since model year 2008. J1850, ISO 9141, KWP2000 and 29-bit CAN are
/// not handled here.
/// </summary>
public sealed class ObdClient
{
    public const string EcmRequestId = "0x7E0";
    public const string EcmResponseId = "0x7E8";

    /// <summary>PIDs the OBD bay reads when the ECU reports them as supported.</summary>
    public static readonly byte[] SnapshotPids = [0x04, 0x05, 0x0B, 0x0C, 0x0D, 0x0F, 0x10, 0x11, 0x1F, 0x21, 0x2F, 0x42, 0x46, 0x5C];

    readonly IIsoTpChannel _channel;

    public ObdClient(IIsoTpChannel channel) => _channel = channel;

    byte[] Request(params byte[] request)
    {
        var response = _channel.SendRequest(request, EcmRequestId, EcmResponseId);
        if (response.Length == 0) throw new InvalidOperationException($"Empty response to OBD service 0x{request[0]:X2}");
        if (response[0] == 0x7F) throw new ObdNegativeResponseException(request[0], response.Length > 2 ? response[2] : (byte)0xFF);
        if (response[0] != (byte)(request[0] + 0x40))
            throw new InvalidOperationException($"Unexpected response 0x{response[0]:X2} to OBD service 0x{request[0]:X2}");
        return response;
    }

    /// <summary>Walks the PID 00/20/40/... support bitmaps.</summary>
    public HashSet<byte> ReadSupportedPids()
    {
        var supported = new HashSet<byte>();
        for (var basePid = 0x00; basePid <= 0xA0; basePid += 0x20)
        {
            byte[] response;
            try { response = Request(0x01, (byte)basePid); }
            catch (ObdNegativeResponseException) when (basePid > 0) { break; }
            if (response.Length < 6 || response[1] != basePid) break;
            var mask = ((uint)response[2] << 24) | ((uint)response[3] << 16) | ((uint)response[4] << 8) | response[5];
            for (var bit = 0; bit < 32; bit++)
            {
                if ((mask & (1u << (31 - bit))) != 0) supported.Add((byte)(basePid + bit + 1));
            }
            if (!supported.Contains((byte)(basePid + 0x20))) break;
        }
        return supported;
    }

    public ObdMonitorStatus ReadMonitorStatus()
    {
        var response = Request(0x01, 0x01);
        if (response.Length < 3) throw new InvalidOperationException("Short PID 01 response");
        var a = response[2];
        return new ObdMonitorStatus
        {
            MilOn = (a & 0x80) != 0,
            DtcCount = a & 0x7F,
            Raw = Convert.ToHexString(response),
        };
    }

    public ObdPidReading ReadPid(byte pid)
    {
        var response = Request(0x01, pid);
        if (response.Length < 3 || response[1] != pid) throw new InvalidOperationException($"Mismatched response for PID 0x{pid:X2}");
        return Decode(pid, response.AsSpan(2));
    }

    public static ObdPidReading Decode(byte pid, ReadOnlySpan<byte> data)
    {
        var bytes = data.ToArray();
        double A(int i = 0) => bytes.Length > i ? bytes[i] : throw new InvalidOperationException($"Short data for PID 0x{pid:X2}");
        double AB() => A(0) * 256 + A(1);
        (string Name, double? Value, string Unit) decoded = pid switch
        {
            0x04 => ("Calculated engine load", Math.Round(A() * 100 / 255, 1), "%"),
            0x05 => ("Coolant temperature", A() - 40, "C"),
            0x0B => ("Intake manifold pressure", A(), "kPa"),
            0x0C => ("Engine speed", AB() / 4, "rpm"),
            0x0D => ("Vehicle speed", A(), "km/h"),
            0x0F => ("Intake air temperature", A() - 40, "C"),
            0x10 => ("Mass air flow", Math.Round(AB() / 100, 2), "g/s"),
            0x11 => ("Throttle position", Math.Round(A() * 100 / 255, 1), "%"),
            0x1F => ("Run time since start", AB(), "s"),
            0x21 => ("Distance with MIL on", AB(), "km"),
            0x2F => ("Fuel level", Math.Round(A() * 100 / 255, 1), "%"),
            0x42 => ("Control module voltage", Math.Round(AB() / 1000, 2), "V"),
            0x46 => ("Ambient air temperature", A() - 40, "C"),
            0x5C => ("Engine oil temperature", A() - 40, "C"),
            _ => ($"PID 0x{pid:X2}", (double?)null, ""),
        };
        return new ObdPidReading
        {
            Pid = $"0x{pid:X2}",
            Name = decoded.Name,
            Value = decoded.Value,
            Unit = decoded.Unit,
            Raw = Convert.ToHexString(bytes),
        };
    }

    /// <summary>Mode 03 (stored), 07 (pending) or 0A (permanent) trouble codes.</summary>
    public string[] ReadDtcs(byte mode)
    {
        if (mode is not (0x03 or 0x07 or 0x0A)) throw new ArgumentOutOfRangeException(nameof(mode));
        var response = Request(mode);
        return ParseDtcs(response);
    }

    /// <summary>ISO 15765-4 format: [0x40+mode, count, A, B, A, B, ...].</summary>
    public static string[] ParseDtcs(byte[] response)
    {
        if (response.Length < 2) return [];
        var codes = new List<string>();
        for (var i = 2; i + 1 < response.Length; i += 2)
        {
            var a = response[i];
            var b = response[i + 1];
            if (a == 0 && b == 0) continue;
            codes.Add(FormatDtc(a, b));
        }
        return codes.ToArray();
    }

    public static string FormatDtc(byte a, byte b)
    {
        var letter = "PCBU"[(a >> 6) & 0x03];
        return $"{letter}{(a >> 4) & 0x03}{a & 0x0F:X1}{b:X2}";
    }

    /// <summary>Mode 04: clears stored codes, freeze frame and readiness monitors.</summary>
    public void ClearDtcs() => Request(0x04);

    /// <summary>Mode 09 PID 02 VIN.</summary>
    public string ReadVin()
    {
        var response = Request(0x09, 0x02);
        // CAN format: 49 02 <count> <17 ASCII bytes>
        var start = response.Length >= 3 + 17 ? 3 : 2;
        var text = Encoding.ASCII.GetString(response, start, response.Length - start);
        var vin = new string(text.Where(ch => ch is >= '0' and <= '9' or >= 'A' and <= 'Z').ToArray());
        return vin.Length >= 17 ? vin[^17..] : vin;
    }
}
