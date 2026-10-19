namespace ShopCrank.J2534.Uds;

/// <summary>
/// Computes the UDS SecurityAccess key from a seed for a given security level.
///
/// Real Stellantis SGW / immobilizer / programming unlocks require licensed
/// AutoAuth credentials and OEM-specific seed→key material. ShopCrank does NOT
/// bundle or reverse-engineer those algorithms; a provider must be supplied at
/// runtime (e.g. an AutoAuth-backed implementation). Absent a real provider,
/// live programming fails closed.
/// </summary>
public interface ISecurityAccessProvider
{
    /// <summary>Human-readable provider name for logs/audit.</summary>
    string Name { get; }

    /// <summary>Return the key bytes for the supplied seed and security level, or throw if unavailable.</summary>
    byte[] ComputeKey(int level, byte[] seed, string vin);
}

/// <summary>Default provider: refuses to compute keys so live programming cannot proceed without licensed credentials.</summary>
public sealed class FailClosedSecurityAccessProvider : ISecurityAccessProvider
{
    public string Name => "none (fail-closed)";

    public byte[] ComputeKey(int level, byte[] seed, string vin) =>
        throw new InvalidOperationException(
            "Live SecurityAccess requires licensed OEM AutoAuth credentials. Configure an AutoAuth security provider; ShopCrank does not bypass manufacturer security gateways.");
}

/// <summary>
/// Bench simulator provider: a deterministic, NON-SECURE transform used only
/// against the built-in simulator so training/demo flows work end to end.
/// Never used against real hardware.
/// </summary>
public sealed class SimulatorSecurityAccessProvider : ISecurityAccessProvider
{
    public string Name => "simulator";

    public byte[] ComputeKey(int level, byte[] seed, string vin)
    {
        var key = new byte[seed.Length];
        for (var i = 0; i < seed.Length; i++) key[i] = (byte)(seed[i] ^ 0x5A);
        return key;
    }
}
