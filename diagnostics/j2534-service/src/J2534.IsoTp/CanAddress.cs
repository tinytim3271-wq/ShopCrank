namespace ShopCrank.J2534.IsoTp;

public static class CanAddress
{
    public static uint Parse(string address)
    {
        var trimmed = address.Trim();
        if (trimmed.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            trimmed = trimmed[2..];
        return Convert.ToUInt32(trimmed, 16);
    }
}
