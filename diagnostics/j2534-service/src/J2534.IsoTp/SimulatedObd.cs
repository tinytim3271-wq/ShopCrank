using System.Text;

namespace MechPro.J2534.IsoTp;

/// <summary>Generic OBD-II (SAE J1979) answers for the bench simulator.</summary>
public static class SimulatedObd
{
    public const string Vin = "1C6SRFHT0LN123456";

    static readonly Dictionary<byte, byte[]> Pids = new()
    {
        [0x01] = [0x81, 0x07, 0x65, 0x00], // MIL on, 1 stored code
        [0x04] = [0x33],                   // 20% load
        [0x05] = [0x82],                   // 90 C coolant
        [0x0C] = [0x0C, 0x30],             // 780 rpm
        [0x0D] = [0x00],                   // 0 km/h
        [0x0F] = [0x41],                   // 25 C intake air
        [0x11] = [0x26],                   // 14.9% throttle
        [0x1F] = [0x00, 0x78],             // 120 s
        [0x21] = [0x00, 0x0C],             // 12 km with MIL on
        [0x2F] = [0x99],                   // 60% fuel
        [0x42] = [0x36, 0xB0],             // 14.0 V
    };

    public static bool Handles(byte service) => service is 0x01 or 0x03 or 0x04 or 0x07 or 0x09 or 0x0A;

    public static byte[] Respond(byte[] request)
    {
        var service = request[0];
        switch (service)
        {
            case 0x01:
            {
                if (request.Length < 2) return [0x7F, 0x01, 0x13];
                var pid = request[1];
                if (pid % 0x20 == 0) return SupportBitmap(pid);
                return Pids.TryGetValue(pid, out var data) ? [0x41, pid, .. data] : [0x7F, 0x01, 0x31];
            }
            case 0x03: return [0x43, 0x01, 0x04, 0x56]; // P0456
            case 0x07: return [0x47, 0x00];
            case 0x0A: return [0x4A, 0x00];
            case 0x04: return [0x44];
            case 0x09:
                return request.Length >= 2 && request[1] == 0x02
                    ? [0x49, 0x02, 0x01, .. Encoding.ASCII.GetBytes(Vin)]
                    : [0x7F, 0x09, 0x31];
            default: return [0x7F, service, 0x11];
        }
    }

    static byte[] SupportBitmap(byte basePid)
    {
        uint mask = 0;
        foreach (var pid in Pids.Keys.Where(p => p > basePid && p <= basePid + 0x20))
            mask |= 1u << (31 - (pid - basePid - 1));
        if (Pids.Keys.Any(p => p > basePid + 0x20)) mask |= 1u; // next range supported
        if (mask == 0) return [0x7F, 0x01, 0x31];
        return [0x41, basePid, (byte)(mask >> 24), (byte)(mask >> 16), (byte)(mask >> 8), (byte)mask];
    }
}
