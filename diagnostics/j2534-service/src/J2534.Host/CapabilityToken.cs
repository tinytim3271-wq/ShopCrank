using System.Collections.Concurrent;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace ShopCrank.J2534.Host;

/// <summary>
/// ECDSA P-256 (ES256) capability tokens (format v2.&lt;payload&gt;.&lt;sig&gt;).
///
/// The Cloudflare Worker signs with a private key that never leaves the server;
/// this host holds only the PUBLIC key and can verify but not mint tokens.
/// Fail-closed: without a configured public key, every authorized procedure is
/// refused. Compatible with the Node verifier and Worker minter.
/// </summary>
public static class CapabilityToken
{
    static readonly ConcurrentDictionary<string, long> Consumed = new();
    static readonly Lazy<ECDsa?> PublicKey = new(LoadPublicKey);

    public sealed record Payload(string Procedure, string Vin, string ShopId, string Mode, string Scope);

    /// <summary>Verify a token scoped to <paramref name="procedure"/> and (optionally) mode/vin. Single-use unless consume=false.</summary>
    public static Payload Verify(string? token, string procedure, string? expectedMode = null, string? expectedVin = null, bool consume = true)
    {
        var raw = (token ?? string.Empty).Trim();
        var parts = raw.Split('.');
        if (parts.Length != 3 || parts[0] != "v2")
        {
            throw new UnauthorizedAccessException("Invalid diagnostics capability token");
        }

        var key = PublicKey.Value
            ?? throw new UnauthorizedAccessException("Diagnostics capability public key is not configured; refusing to authorize.");

        var signingInput = Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}");
        var signature = Base64UrlDecode(parts[2]);
        if (!key.VerifyData(signingInput, signature, HashAlgorithmName.SHA256))
        {
            throw new UnauthorizedAccessException("Invalid diagnostics capability token signature");
        }

        using var doc = JsonDocument.Parse(Encoding.UTF8.GetString(Base64UrlDecode(parts[1])));
        var root = doc.RootElement;
        if (root.GetProperty("v").GetInt32() != 2)
        {
            throw new UnauthorizedAccessException("Unsupported capability token version");
        }

        var proc = root.GetProperty("procedure").GetString();
        var vin = root.GetProperty("vin").GetString();
        var shopId = root.GetProperty("shopId").GetString();
        var mode = root.GetProperty("mode").GetString();
        var scope = root.TryGetProperty("scope", out var s) ? s.GetString() ?? "" : "";
        var jti = root.GetProperty("jti").GetString();
        var exp = root.GetProperty("exp").GetInt64();

        if (string.IsNullOrWhiteSpace(proc) || string.IsNullOrWhiteSpace(vin)
            || string.IsNullOrWhiteSpace(shopId) || string.IsNullOrWhiteSpace(mode) || string.IsNullOrWhiteSpace(jti))
        {
            throw new UnauthorizedAccessException("Capability token payload is incomplete");
        }
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > exp)
        {
            throw new UnauthorizedAccessException("Capability token expired");
        }
        if (!string.Equals(proc, procedure, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException($"Capability token is not valid for {procedure}");
        }
        if (expectedMode is not null && !string.Equals(mode, expectedMode, StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("Capability token mode mismatch");
        }
        if (expectedVin is not null && !string.Equals(vin, expectedVin.Trim().ToUpperInvariant(), StringComparison.Ordinal))
        {
            throw new UnauthorizedAccessException("Capability token VIN mismatch");
        }

        if (consume)
        {
            PruneConsumed();
            if (!Consumed.TryAdd(jti!, exp))
            {
                throw new UnauthorizedAccessException("Capability token already used");
            }
        }

        return new Payload(proc!, vin!, shopId!, mode!, scope);
    }

    static void PruneConsumed()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var kv in Consumed)
        {
            if (kv.Value <= now) Consumed.TryRemove(kv.Key, out _);
        }
    }

    static ECDsa? LoadPublicKey()
    {
        var inline = Environment.GetEnvironmentVariable("DIAGNOSTICS_SIGNING_PUBLIC_KEY");
        if (!string.IsNullOrWhiteSpace(inline))
        {
            return ImportPublicKey(inline);
        }

        var candidates = new List<string>();
        var explicitFile = Environment.GetEnvironmentVariable("DIAGNOSTICS_SIGNING_PUBLIC_KEY_FILE");
        if (!string.IsNullOrWhiteSpace(explicitFile)) candidates.Add(explicitFile);
        var baseDir = AppContext.BaseDirectory;
        candidates.Add(Path.Combine(baseDir, "diagnostics-keys", "capability-public-key.pem"));
        candidates.Add(Path.Combine(baseDir, "capability-public-key.pem"));

        foreach (var candidate in candidates)
        {
            try
            {
                if (File.Exists(candidate)) return ImportPublicKey(File.ReadAllText(candidate));
            }
            catch { /* try next candidate */ }
        }
        return null;
    }

    static ECDsa ImportPublicKey(string material)
    {
        var ecdsa = ECDsa.Create();
        if (material.Contains("BEGIN"))
        {
            ecdsa.ImportFromPem(material);
        }
        else
        {
            ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(material.Trim()), out _);
        }
        return ecdsa;
    }

    static byte[] Base64UrlDecode(string input)
    {
        var padded = input.Replace('-', '+').Replace('_', '/');
        switch (padded.Length % 4)
        {
            case 2: padded += "=="; break;
            case 3: padded += "="; break;
        }
        return Convert.FromBase64String(padded);
    }
}
