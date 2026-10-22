namespace ShopCrank.J2534.Uds;

/// <summary>
/// SecurityAccess key derived from the vehicle's own immobilizer PIN.
/// This is the PIN the car (or CONSULT) already asks for — not OEM seed/key math.
/// </summary>
public sealed class PinSecurityAccessProvider : ISecurityAccessProvider
{
    readonly string _pin;

    public PinSecurityAccessProvider(string pin) => _pin = (pin ?? "").Trim();

    public string Name => "vehicle-pin";

    public byte[] ComputeKey(int level, byte[] seed, string vin)
    {
        if (seed is null || seed.Length == 0)
            throw new InvalidOperationException("The vehicle did not return a SecurityAccess seed.");
        if (_pin.Length is < 4 or > 6 || !_pin.All(c => c is >= '0' and <= '9'))
            throw new InvalidOperationException("Enter the 4- to 6-digit Nissan immobilizer PIN. Shop Crank does not recover or bypass that PIN.");
        if (seed.Length == 2 && _pin.Length == 4)
        {
            var digits = _pin.Select(c => (byte)(c - '0')).ToArray();
            var key = new byte[2];
            key[0] = (byte)((digits[0] << 4) | digits[1]);
            key[1] = (byte)((digits[2] << 4) | digits[3]);
            return key;
        }
        if (seed.Length == 4 && _pin.Length == 4)
            return System.Text.Encoding.ASCII.GetBytes(_pin);
        throw new InvalidOperationException("This Nissan PIN and SecurityAccess seed combination has no verified encoding; no key was sent.");
    }
}
