using ShopCrank.J2534.Uds;
using Xunit;

namespace ShopCrank.J2534.Host.Tests;

[Collection("EnvironmentVariables")]
public class CloudSecurityAccessProviderTests
{
    [Fact]
    public void Refuses_live_key_request_without_an_authorized_job_token()
    {
        var previousBase = Environment.GetEnvironmentVariable("SHOP_CRANK_API_BASE");
        var previousCookie = Environment.GetEnvironmentVariable("SHOP_CRANK_SESSION_COOKIE");
        Environment.SetEnvironmentVariable("SHOP_CRANK_API_BASE", "http://127.0.0.1:9/api");
        Environment.SetEnvironmentVariable("SHOP_CRANK_SESSION_COOKIE", "shopcrank_session=test");
        try
        {
            var provider = new CloudSecurityAccessProvider();
            var error = Assert.Throws<InvalidOperationException>(() => provider.ComputeKey(0x03, [0xA1, 0xB2], "1C6SRFHT0LN123456"));
            Assert.Contains("authorized job", error.Message);
        }
        finally
        {
            Environment.SetEnvironmentVariable("SHOP_CRANK_API_BASE", previousBase);
            Environment.SetEnvironmentVariable("SHOP_CRANK_SESSION_COOKIE", previousCookie);
        }
    }
}
