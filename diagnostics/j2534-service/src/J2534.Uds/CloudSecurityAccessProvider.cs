using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace ShopCrank.J2534.Uds;

/// <summary>
/// Live SecurityAccess key computation via the ShopCrank Worker.
/// The host never sees OEM seed→key algorithms; it posts the ECU seed to
/// <c>POST /api/diagnostics/security-access</c>, which uses the shop's stored
/// AutoAuth login (and optional <c>AUTOAUTH_UNLOCK_URL</c>) to obtain the key.
/// The Worker only releases a key for the live capability token of an
/// authorized job, so the token issued by <c>/diagnostics/authorize</c> rides along.
/// </summary>
public sealed class CloudSecurityAccessProvider(string? authorizationToken = null) : ISecurityAccessProvider
{
    static readonly HttpClient Http = CreateClient();
    static readonly JsonSerializerOptions JsonOpts = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public string Name => "cloud-autoauth";

    public byte[] ComputeKey(int level, byte[] seed, string vin)
    {
        var baseUrl = (Environment.GetEnvironmentVariable("SHOP_CRANK_API_BASE") ?? "").TrimEnd('/');
        var cookie = Environment.GetEnvironmentVariable("SHOP_CRANK_SESSION_COOKIE") ?? "";
        if (string.IsNullOrWhiteSpace(baseUrl) || string.IsNullOrWhiteSpace(cookie))
        {
            throw new InvalidOperationException(
                "Live SecurityAccess needs the ShopCrank desktop session. Sign in to ShopCrank Desktop, connect AutoAuth in OEM Diagnostics, then unlock again.");
        }
        if (string.IsNullOrWhiteSpace(authorizationToken))
        {
            throw new InvalidOperationException(
                "Live SecurityAccess needs an authorized job. Start the procedure from Key programming or Module programming so ShopCrank authorizes it first.");
        }

        var payload = new
        {
            vin,
            level,
            scope = level >= 0x05 ? "flash" : "immobilizer",
            seedBase64 = Convert.ToBase64String(seed),
            authorizationToken,
        };
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/diagnostics/security-access")
        {
            Content = new StringContent(JsonSerializer.Serialize(payload, JsonOpts), Encoding.UTF8, "application/json"),
        };
        request.Headers.TryAddWithoutValidation("Cookie", cookie);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = Http.Send(request);
        var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode)
        {
            var message = TryReadMessage(body) ?? $"SecurityAccess unlock failed ({(int)response.StatusCode}).";
            throw new InvalidOperationException(message);
        }

        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        if (!doc.RootElement.TryGetProperty("keyBase64", out var keyProp) || keyProp.GetString() is not { Length: > 0 } keyB64)
        {
            throw new InvalidOperationException("SecurityAccess unlock returned no key. Check the shop AutoAuth login and AUTOAUTH_UNLOCK_URL.");
        }
        return Convert.FromBase64String(keyB64);
    }

    static string? TryReadMessage(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
            if (doc.RootElement.TryGetProperty("message", out var message)) return message.GetString();
        }
        catch { /* ignore parse errors */ }
        return null;
    }

    static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(45) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("ShopCrank-J2534-Host/1.0");
        return client;
    }
}
