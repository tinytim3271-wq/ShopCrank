namespace ShopCrank.J2534.Native;

public static class PassThruMsgHelper
{
    public static PassThruMsg Create(uint protocolId, uint canId, ReadOnlySpan<byte> payload, uint txFlags = 0)
    {
        var msg = new PassThruMsg
        {
            ProtocolID = protocolId,
            TxFlags = txFlags,
            Data = new byte[4128],
        };
        WriteCanId(msg.Data, canId);
        payload.CopyTo(msg.Data.AsSpan(4));
        msg.DataSize = (uint)(4 + payload.Length);
        return msg;
    }

    public static void WriteCanId(byte[] buffer, uint canId)
    {
        buffer[0] = (byte)((canId >> 24) & 0xFF);
        buffer[1] = (byte)((canId >> 16) & 0xFF);
        buffer[2] = (byte)((canId >> 8) & 0xFF);
        buffer[3] = (byte)(canId & 0xFF);
    }

    public static uint ReadCanId(ReadOnlySpan<byte> data) =>
        ((uint)data[0] << 24) | ((uint)data[1] << 16) | ((uint)data[2] << 8) | data[3];

    public static byte[] ExtractIso15765Payload(ReadOnlySpan<byte> data)
    {
        if (data.Length < 5) return [];

        var pci = data[4];
        if ((pci & 0xF0) == 0x00)
        {
            var length = pci & 0x0F;
            return data.Slice(5, length).ToArray();
        }

        if ((pci & 0xF0) == 0x10)
        {
            var totalLength = ((pci & 0x0F) << 8) | data[5];
            using var stream = new MemoryStream(totalLength);
            stream.Write(data.Slice(6));
            return stream.ToArray();
        }

        return data.Slice(5).ToArray();
    }

    public static byte[] ReassembleIso15765Frames(IReadOnlyList<PassThruMsg> messages)
    {
        if (messages.Count == 0) return [];

        var first = messages[0].Data.AsSpan(0, (int)messages[0].DataSize);
        if (first.Length < 5) return [];

        var pci = first[4];
        if ((pci & 0xF0) == 0x00)
            return ExtractIso15765Payload(first);

        if ((pci & 0xF0) != 0x10)
            return ExtractIso15765Payload(first);

        var totalLength = ((pci & 0x0F) << 8) | first[5];
        var buffer = new byte[totalLength];
        var firstChunk = first.Slice(6);
        firstChunk.Slice(0, Math.Min(firstChunk.Length, totalLength)).CopyTo(buffer);

        var offset = firstChunk.Length;
        for (var i = 1; i < messages.Count && offset < totalLength; i++)
        {
            var frame = messages[i].Data.AsSpan(0, (int)messages[i].DataSize);
            if (frame.Length < 5) continue;
            var chunk = frame.Slice(5);
            var copy = Math.Min(chunk.Length, totalLength - offset);
            chunk.Slice(0, copy).CopyTo(buffer.AsSpan(offset));
            offset += copy;
        }

        return buffer;
    }
}
