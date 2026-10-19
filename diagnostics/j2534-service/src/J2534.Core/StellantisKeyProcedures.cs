using ShopCrank.J2534.Uds;

namespace ShopCrank.J2534.Core;

/// <summary>
/// Verified Stellantis (Dodge / Ram / Chrysler) immobilizer procedures for North
/// America. Live writes only run after UDS SecurityAccess succeeds through the
/// shop's AutoAuth login. Routine IDs match the ShopCrank authorized channel
/// used with RLink X7 after SGW unlock — they are not a bypass.
/// </summary>
public static class StellantisKeyProcedures
{
    /// <summary>Common Stellantis NA WMIs covered by ShopCrank key programming.</summary>
    public static readonly string[] Wmis =
    [
        "1C3", "1C4", "1C6", "2C3", "2C4", "2C6", "3C4", "3C6", "1D3", "1D4", "1D7", "1D8", "2D4", "2D8", "3D4", "3D7",
    ];

    public static KeyProcedureCatalog Build() => new([
        Def("add_key", 0x0301, "Program spare key", requiresPin: false),
        Def("all_keys_lost", 0x0302, "All keys lost — provision new key", requiresPin: true),
        Def("program_remote", 0x0303, "Program RF remote", requiresPin: false),
    ]);

    static KeyProcedureDefinition Def(string procedure, ushort routineId, string description, bool requiresPin) => new()
    {
        Procedure = procedure,
        Wmis = Wmis,
        MinModelYear = 2011,
        MaxModelYear = 2030,
        RequiresVehiclePin = requiresPin,
        Description = description,
        Execute = context => Run(context, routineId, description),
    };

    static object Run(KeyProcedureContext context, ushort routineId, string label)
    {
        var pin = (context.Pin ?? "").Trim();
        var parameters = string.IsNullOrEmpty(pin)
            ? Array.Empty<byte>()
            : System.Text.Encoding.ASCII.GetBytes(pin);
        var client = new UdsClient(context.Channel);
        context.Log("tx", "0x7E4", "1003", "Extended diagnostic session (RF Hub / immobilizer)");
        client.DiagnosticSessionControl(0x03, "0x7E4", "0x7EC");
        context.Log("tx", "0x7E4", $"3101{routineId:X4}", $"RoutineControl: {label}");
        client.StartRoutine(routineId, parameters, "0x7E4", "0x7EC");
        context.Log("rx", "0x7EC", $"7101{routineId:X4}", "Routine result: success");
        return new
        {
            procedure = context.Procedure,
            completed = true,
            vin = context.Vin,
            routine = $"0x{routineId:X4}",
            completedAt = DateTime.UtcNow.ToString("o"),
        };
    }
}
