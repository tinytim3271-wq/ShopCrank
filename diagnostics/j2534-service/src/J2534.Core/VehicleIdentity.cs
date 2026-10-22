namespace ShopCrank.J2534.Core;

public sealed class VehicleIdentity
{
    public string Make { get; init; } = "Unknown";
    public string Model { get; init; } = "";
    public string Platform { get; init; } = "unknown";
    public int Year { get; init; }
    public string IgnitionType { get; init; } = "unknown";

    public static VehicleIdentity FromVin(string vin)
    {
        vin = (vin ?? "").Trim().ToUpperInvariant();
        var year = KeyProcedureCatalog.ModelYear(vin);
        if (vin.Length < 3) return new VehicleIdentity { Year = year };
        var wmi = vin[..3];
        if (NissanKeyProcedures.IsMaxima(vin))
        {
            var platform = year >= 2016 ? "A36" : year >= 2009 ? "A35" : "A34";
            return new VehicleIdentity
            {
                Make = "Nissan",
                Model = "Maxima",
                Platform = platform,
                Year = year,
                IgnitionType = year >= 2016 ? "push_button" : "mechanical",
            };
        }
        if (wmi is "1N4" or "JN1" or "3N1" or "5N1")
            return new VehicleIdentity { Make = "Nissan", Year = year, Platform = "nissan" };
        if (wmi is "1C6" or "3C6")
            return new VehicleIdentity { Make = "Ram", Year = year, Platform = PlatformFromRamVin(vin) };
        if (wmi is "1D7" or "1B3" or "2C3")
            return new VehicleIdentity { Make = "Dodge", Year = year, Platform = PlatformFromRamVin(vin) };
        return new VehicleIdentity { Make = "Unknown", Year = year };
    }

    static string PlatformFromRamVin(string vin)
    {
        if (vin.Length < 4) return "unknown";
        return vin[3] switch
        {
            'R' => "DT",
            'H' => "DJ",
            'C' => "LD",
            'J' => "JC",
            'U' => "DS",
            _ => "unknown",
        };
    }
}
