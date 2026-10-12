using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ShopCrank.J2534.Core;
using ShopCrank.J2534.Host;
using Xunit;

namespace ShopCrank.J2534.Host.Tests;

public sealed class RpcDispatcherTests
{
    [Fact]
    public async Task MutationsRequireAuthorizationForTheConnectedVin()
    {
        using var signingKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        Environment.SetEnvironmentVariable(
            "DIAGNOSTICS_SIGNING_PUBLIC_KEY",
            Convert.ToBase64String(signingKey.ExportSubjectPublicKeyInfo()));
        Environment.SetEnvironmentVariable("SHOP_CRANK_J2534_TOKEN", "test-host-token");

        using var session = new DiagnosticSession();
        session.Connect(new ConnectParams { AdapterId = "simulator" });
        var vinElement = JsonSerializer.SerializeToElement(await session.ReadVinAsync());
        var vin = vinElement.GetProperty("vin").GetString()!;
        var otherVin = (vin[0] == '1' ? "2" : "1") + vin[1..];

        var mutations = new (string Method, string Procedure, object Extras)[]
        {
            (Method: "clearDtcs", Procedure: "clear_dtcs", Extras: new { }),
            (Method: "addKey", Procedure: "add_key", Extras: new { }),
            (Method: "flashModule", Procedure: "module_flash", Extras: new { firmware = new { data = "AA" } }),
            (Method: "codeModule", Procedure: "module_coding", Extras: new { did = "1234", data = "00" }),
            (Method: "bidirectionalControl", Procedure: "bidirectional_control", Extras: new { control = "cooling_fan", state = "on" }),
        };

        foreach (var (method, procedure, extras) in mutations)
        {
            var request = CreateRequest(method, CreateParams(signingKey, procedure, otherVin, extras));
            var response = await RpcDispatcher.DispatchAsync(request, session);
            Assert.Equal("Capability token VIN mismatch", response.Error?.Message);
        }

        var authorizedRequest = CreateRequest(
            "clearDtcs",
            CreateParams(signingKey, "clear_dtcs", vin, new { }));
        var authorizedResponse = await RpcDispatcher.DispatchAsync(authorizedRequest, session);
        Assert.Null(authorizedResponse.Error);
    }

    static JsonRpcRequest CreateRequest(string method, object parameters) =>
        new()
        {
            Id = method,
            Method = method,
            Params = JsonSerializer.SerializeToElement(parameters),
        };

    static object CreateParams(ECDsa signingKey, string procedure, string vin, object extras)
    {
        var token = CreateToken(signingKey, procedure, vin);
        var values = new Dictionary<string, object?>
        {
            ["authToken"] = "test-host-token",
            ["authorizationToken"] = token,
        };
        foreach (var property in JsonSerializer.SerializeToElement(extras).EnumerateObject())
        {
            values[property.Name] = property.Value.Clone();
        }
        return values;
    }

    static string CreateToken(ECDsa signingKey, string procedure, string vin)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(new
        {
            v = 2,
            procedure,
            vin = vin.ToUpperInvariant(),
            shopId = "test-shop",
            mode = "simulate",
            jti = Guid.NewGuid().ToString("N"),
            exp = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds(),
            scope = "vehicle",
        });
        var encodedPayload = Base64UrlEncode(payload);
        var signingInput = Encoding.UTF8.GetBytes($"v2.{encodedPayload}");
        var signature = signingKey.SignData(
            signingInput,
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"v2.{encodedPayload}.{Base64UrlEncode(signature)}";
    }

    static string Base64UrlEncode(byte[] value) =>
        Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}
