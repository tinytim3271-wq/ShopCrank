using System.Text;

namespace MechPro.J2534.IsoTp;

/// <summary>Bench simulator for development without a J2534 adapter.</summary>
public sealed class SimulatedIsoTpChannel : IIsoTpChannel
{
    readonly Action<string, string, string, string> _log;

    public SimulatedIsoTpChannel(Action<string, string, string, string> log) => _log = log;

    public byte[] SendRequest(byte[] request, string txId, string rxId)
    {
        var txHex = Convert.ToHexString(request);
        _log("tx", txId, txHex, "ISO-TP request (simulator)");

        var response = BuildSimulatedResponse(request);
        _log("rx", rxId, Convert.ToHexString(response), "ISO-TP response (simulator)");
        return response;
    }

    static byte[] BuildSimulatedResponse(byte[] request)
    {
        if (request.Length >= 3 && request[0] == 0x22)
        {
            var did = (request[1] << 8) | request[2];
            return did switch
            {
                0xF190 => BuildPositiveRead("F190", Encoding.ASCII.GetBytes("1C6SRFHT0LN123456")),
                0xF18A => BuildPositiveRead("F18A", Encoding.ASCII.GetBytes("68429235AE")),
                0xF189 => BuildPositiveRead("F189", Encoding.ASCII.GetBytes("23.23.1")),
                0xF18C => BuildPositiveRead("F18C", Encoding.ASCII.GetBytes("DT_GW_2024")),
                _ => [0x7F, request[0], 0x31],
            };
        }
        if (request.Length >= 1 && SimulatedObd.Handles(request[0])) return SimulatedObd.Respond(request);
        if (request.Length >= 1 && request[0] == 0x19) return [0x59, 0x02, 0xFF];
        if (request.Length >= 1 && request[0] == 0x14) return [0x54];
        if (request.Length >= 1 && request[0] == 0x10) return [0x50, request[1], 0x00, 0x32, 0x01, 0xF4];
        return [0x7F, request[0], 0x11];
    }

    static byte[] BuildPositiveRead(string didHex, byte[] value)
    {
        var did = Convert.FromHexString(didHex);
        var result = new byte[1 + did.Length + value.Length];
        result[0] = 0x62;
        did.CopyTo(result, 1);
        value.CopyTo(result, 1 + did.Length);
        return result;
    }
}
