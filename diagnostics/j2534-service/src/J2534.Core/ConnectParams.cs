namespace ShopCrank.J2534.Core;

public sealed class ConnectParams
{
    public string? AdapterId { get; set; }
    public string? Protocol { get; set; }
    public int? BaudRate { get; set; }
}
