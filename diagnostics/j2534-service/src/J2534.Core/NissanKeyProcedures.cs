using ShopCrank.J2534.Uds;

namespace ShopCrank.J2534.Core;

/// <summary>
/// CONSULT-style Nissan Maxima NATS / Intelligent Key registration over UDS.
/// Uses the vehicle immobilizer PIN (not OEM seed/key math). BCM addresses and
/// register-ID routines follow Nissan CONSULT work-support on A34/A35/A36.
/// </summary>
public static class NissanKeyProcedures
{
    public static readonly string[] MaximaWmis = ["1N4", "JN1"];
    public static readonly string[] MaximaVdsPrefixes = ["AA", "BA"];

    public static IReadOnlyList<KeyProcedureDefinition> Definitions { get; } = Build();

    public static KeyProcedureCatalog Catalog { get; } = new(Definitions);

    public static bool IsMaxima(string vin)
    {
        vin = (vin ?? "").Trim().ToUpperInvariant();
        if (vin.Length < 5) return false;
        return MaximaWmis.Contains(vin[..3], StringComparer.OrdinalIgnoreCase)
            && MaximaVdsPrefixes.Contains(vin[3..5], StringComparer.OrdinalIgnoreCase);
    }

    static List<KeyProcedureDefinition> Build()
    {
        var list = new List<KeyProcedureDefinition>();
        foreach (var procedure in KeyProcedureCatalog.Procedures)
        {
            list.Add(new KeyProcedureDefinition
            {
                Procedure = procedure,
                Wmis = MaximaWmis,
                VdsPrefixes = MaximaVdsPrefixes,
                MinModelYear = 2004,
                MaxModelYear = 2023,
                RequiresVehiclePin = true,
                Description = Description(procedure),
                Execute = context => Run(context, procedure),
            });
        }
        return list;
    }

    static string Description(string procedure) => procedure switch
    {
        "add_key" => "Nissan Maxima NATS / Intelligent Key: register an additional key with the immobilizer PIN.",
        "all_keys_lost" => "Nissan Maxima all-keys-lost ID registration. Requires the immobilizer PIN and a working transponder or Intelligent Key.",
        "program_remote" => "Nissan Maxima remote / Intelligent Key fob registration with the immobilizer PIN.",
        "erase_keys" => "Nissan Maxima immobilizer initialize / erase. Requires the immobilizer PIN.",
        _ => $"Nissan Maxima {procedure.Replace('_', ' ')}.",
    };

    static readonly (string Tx, string Rx, string Name)[] BcmAddresses =
    [
        ("0x743", "0x763", "BCM"),
        ("0x745", "0x765", "Intelligent Key"),
    ];

    static ushort RoutineId(string procedure) => procedure switch
    {
        "add_key" => 0x0202,
        "all_keys_lost" => 0x0203,
        "program_remote" => 0x0204,
        "erase_keys" => 0x0205,
        _ => 0x0202,
    };

    public static object Run(KeyProcedureContext context, string procedure)
    {
        if (!IsMaxima(context.Vin))
            throw new InvalidOperationException("This live key procedure is for Nissan Maxima (VIN 1N4AA / 1N4BA / JN1AA).");
        var pin = (context.Pin ?? "").Trim();
        if (pin.Length is < 4 or > 6 || !pin.All(char.IsDigit))
            throw new InvalidOperationException("Enter the 4- to 6-digit Nissan immobilizer PIN from CONSULT or the owner. Shop Crank does not recover or bypass that PIN.");

        var client = new UdsClient(context.Channel);
        (string Tx, string Rx, string Name)? selectedEcu = null;
        foreach (var ecu in BcmAddresses)
        {
            try
            {
                _ = client.ReadEcuIdentificationAsync(ecu.Tx, ecu.Rx).GetAwaiter().GetResult();
                selectedEcu = ecu;
                break;
            }
            catch (Exception ex)
            {
                context.Log("rx", ecu.Rx, "", $"{ecu.Name} {ecu.Tx} identification failed: {ex.Message}");
            }
        }
        if (selectedEcu is not { } target)
            throw new InvalidOperationException("No compatible Nissan key module responded to read-only identification. No security or registration request was sent.");
        return RunOnEcu(context, procedure, pin, target.Tx, target.Rx, target.Name);
    }

    static object RunOnEcu(KeyProcedureContext context, string procedure, string pin, string tx, string rx, string ecuName)
    {
        var client = new UdsClient(context.Channel);
        context.Log("tx", tx, "1003", $"Extended diagnostic session ({ecuName})");
        client.DiagnosticSessionControl(0x03, tx, rx);
        var provider = new PinSecurityAccessProvider(pin);
        context.Log("tx", tx, "2701", $"SecurityAccess with vehicle PIN ({provider.Name})");
        try
        {
            client.SecurityAccess(0x01, provider, context.Vin, tx, rx);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"Nissan security access failed on {ecuName}; no registration routine was sent. Verify the vehicle state with Nissan CONSULT before retrying. {ex.Message}");
        }
        var routine = RoutineId(procedure);
        var pinBytes = System.Text.Encoding.ASCII.GetBytes(pin);
        context.Log("tx", tx, $"3101{routine:X4}", $"Register ID routine {procedure}");
        try
        {
            client.StartRoutine(routine, pinBytes, tx, rx);
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException(
                $"Nissan key registration result is indeterminate on {ecuName}. Do not retry; verify key status with Nissan CONSULT before proceeding. {ex.Message}");
        }
        return new
        {
            procedure,
            completed = true,
            vin = context.Vin,
            ecu = tx,
            ecuName,
            routine = $"0x{routine:X4}",
            completedAt = DateTime.UtcNow.ToString("o"),
        };
    }
}
