namespace MechPro.J2534.Native;

public static class J2534Status
{
    public const int STATUS_NOERROR = 0x00;
    public const int ERR_TIMEOUT = 0x09;
    public const int ERR_BUFFER_EMPTY = 0x10;
    public const int ERR_DEVICE_NOT_CONNECTED = 0x08;

    public const uint FILTER_PASS_FILTER = 0x00000001;
    public const uint FILTER_FLOW_CONTROL_FILTER = 0x00000003;

    public const uint ISO15765_FRAME_PAD = 0x00000040;

    // PASSTHRU_MSG.RxStatus bits (SAE J2534-1 v04.04).
    public const uint TX_MSG_TYPE = 0x00000001;
    public const uint ISO15765_FIRST_FRAME = 0x00000002;
    public const uint CAN_29BIT_ID = 0x00000100;
}
