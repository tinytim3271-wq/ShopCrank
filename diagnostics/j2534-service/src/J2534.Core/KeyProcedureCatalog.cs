namespace MechPro.J2534.Core;

/// <summary>
/// A live immobilizer procedure that has been checked against the manufacturer's
/// documented sequence and validated on a real vehicle. Only these may write to
/// a vehicle. The OEM-specific routine and its security handshake are supplied
/// by <see cref="Execute"/>; MechPro never invents routine IDs or seed/key math.
/// </summary>
public sealed class KeyProcedureDefinition
{
    public string Procedure { get; init; } = "";
    /// <summary>VIN world manufacturer identifiers (first 3 characters) this applies to.</summary>
    public string[] Wmis { get; init; } = [];
    public int MinModelYear { get; init; }
    public int MaxModelYear { get; init; }
    /// <summary>The vehicle itself asks for an immobilizer PIN during the procedure.</summary>
    public bool RequiresVehiclePin { get; init; }
    public string Description { get; init; } = "";
    public Func<KeyProcedureContext, object>? Execute { get; init; }
}

public sealed class KeyProcedureContext
{
    public string Vin { get; init; } = "";
    public string Procedure { get; init; } = "";
    public string? Pin { get; init; }
    public Action<string, string, string, string> Log { get; init; } = (_, _, _, _) => { };
    public MechPro.J2534.IsoTp.IIsoTpChannel Channel { get; init; } = null!;
}

public sealed class KeyProcedureSupport
{
    public bool Supported { get; init; }
    public bool Simulator { get; init; }
    public string Procedure { get; init; } = "";
    public string Vin { get; init; } = "";
    public bool RequiresVehiclePin { get; init; }
    public string Reason { get; init; } = "";
}

public sealed class KeyProcedureCatalog
{
    public static readonly string[] Procedures = ["add_key", "all_keys_lost", "program_remote", "erase_keys"];

    /// <summary>
    /// The shipped catalog. It is intentionally empty: no live key procedure has
    /// been validated on a vehicle yet, so live attempts report "not supported"
    /// instead of sending guessed commands.
    /// </summary>
    public static KeyProcedureCatalog Default { get; } = new([]);

    readonly IReadOnlyList<KeyProcedureDefinition> _verified;

    public KeyProcedureCatalog(IEnumerable<KeyProcedureDefinition> verified) => _verified = verified.ToList();

    public KeyProcedureDefinition? Find(string procedure, string vin)
    {
        var wmi = vin.Length >= 3 ? vin[..3].ToUpperInvariant() : "";
        var year = ModelYear(vin);
        return _verified.FirstOrDefault(def =>
            def.Procedure == procedure
            && def.Wmis.Contains(wmi, StringComparer.OrdinalIgnoreCase)
            && (def.MinModelYear == 0 || year >= def.MinModelYear)
            && (def.MaxModelYear == 0 || year <= def.MaxModelYear));
    }

    public KeyProcedureSupport Evaluate(string procedure, string vin, bool simulator)
    {
        procedure = (procedure ?? "").Trim();
        vin = (vin ?? "").Trim().ToUpperInvariant();
        if (!Procedures.Contains(procedure))
            return new KeyProcedureSupport { Supported = false, Simulator = simulator, Procedure = procedure, Vin = vin, Reason = $"Unknown key procedure '{procedure}'." };
        if (simulator)
            return new KeyProcedureSupport { Supported = true, Simulator = true, Procedure = procedure, Vin = vin, Reason = "Bench simulator. Nothing is written to a vehicle." };
        if (vin.Length != 17)
            return new KeyProcedureSupport { Supported = false, Procedure = procedure, Vin = vin, Reason = "Could not read a 17-character VIN from the vehicle. Check the adapter connection and ignition." };
        var definition = Find(procedure, vin);
        if (definition is null)
        {
            return new KeyProcedureSupport
            {
                Supported = false,
                Procedure = procedure,
                Vin = vin,
                Reason = $"MechPro does not have a verified live {procedure.Replace('_', ' ')} procedure for this vehicle ({vin[..3]}, model year {ModelYear(vin)}). Nothing was written. Use the manufacturer's software (for example wiTECH 2.0, Techstream or FDRS) through the RLink X7 for this job.",
            };
        }
        return new KeyProcedureSupport
        {
            Supported = definition.Execute is not null,
            Procedure = procedure,
            Vin = vin,
            RequiresVehiclePin = definition.RequiresVehiclePin,
            Reason = definition.Execute is null ? "Procedure is listed but has no executor." : definition.Description,
        };
    }

    public static int ModelYear(string vin)
    {
        if (vin.Length < 10) return 0;
        const string codes = "ABCDEFGHJKLMNPRSTVWXY123456789";
        var index = codes.IndexOf(char.ToUpperInvariant(vin[9]));
        if (index < 0) return 0;
        // Letters/digits cycle every 30 years; position 7 being alphabetic marks 2010+.
        var baseYear = 1980 + index;
        var newCycle = vin.Length > 6 && char.IsLetter(vin[6]);
        return newCycle ? baseYear + 30 : baseYear;
    }
}
