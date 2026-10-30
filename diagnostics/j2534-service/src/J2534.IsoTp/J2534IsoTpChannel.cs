using ShopCrank.J2534.Native;

namespace ShopCrank.J2534.IsoTp;

/// <summary>ISO-TP over a live J2534 Pass-Thru ISO15765 channel.</summary>
public sealed class J2534IsoTpChannel : IIsoTpChannel
{
    readonly PassThruDevice _device;
    readonly Action<string, string, string, string> _log;

    public J2534IsoTpChannel(PassThruDevice device, Action<string, string, string, string> log)
    {
        _device = device;
        _log = log;
    }

    public byte[] SendRequest(byte[] request, string txId, string rxId)
    {
        var txCan = CanAddress.Parse(txId);
        var rxCan = CanAddress.Parse(rxId);
        _log("tx", txId, RedactSensitivePayload(request), "ISO-TP request (J2534)");
        var response = _device.Transact(txCan, rxCan, request);
        _log("rx", rxId, RedactSensitivePayload(response), "ISO-TP response (J2534)");
        return response;
    }

    static string RedactSensitivePayload(byte[] request)
    {
        var hex = Convert.ToHexString(request);
        if (request.Length > 2 && request[0] is 0x27 or 0x67)
            return $"{hex[..4]}[REDACTED]";
        if (request.Length > 4 && request[0] is 0x31 or 0x71)
            return $"{hex[..8]}[REDACTED]";
        return hex;
    }
}
