using System.Runtime.InteropServices;

namespace ShopCrank.J2534.Native;

/// <summary>SAE J2534-1 Pass-Thru API P/Invoke definitions.</summary>
public static class PassThruApi
{
    public const uint PROTOCOL_CAN = 0x05;
    public const uint PROTOCOL_ISO15765 = 0x06;
    public const uint PROTOCOL_ISO15765_FD = 0x0F;

    public const uint IOCTL_READ_VBATT = 0x03;
    public const uint IOCTL_GET_CONFIG = 0x01;

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr LoadLibrary(string lpFileName);

    [DllImport("kernel32", SetLastError = true)]
    public static extern bool FreeLibrary(IntPtr hModule);

    [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern IntPtr GetProcAddress(IntPtr hModule, string procName);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruOpenDelegate(IntPtr pName, ref uint pDeviceID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruCloseDelegate(uint DeviceID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruConnectDelegate(uint DeviceID, uint ProtocolID, uint Flags, uint BaudRate, ref uint pChannelID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruDisconnectDelegate(uint ChannelID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruReadMsgsDelegate(uint ChannelID, IntPtr pMsg, ref uint pNumMsgs, uint Timeout);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruWriteMsgsDelegate(uint ChannelID, IntPtr pMsg, ref uint pNumMsgs, uint Timeout);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruStartMsgFilterDelegate(uint ChannelID, uint FilterType, IntPtr pMaskMsg, IntPtr pPatternMsg, IntPtr pFlowControlMsg, ref uint pFilterID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruStopMsgFilterDelegate(uint ChannelID, uint FilterID);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int PassThruIoctlDelegate(uint ChannelID, uint IoctlID, IntPtr pInput, IntPtr pOutput);
}

[StructLayout(LayoutKind.Sequential)]
public struct PassThruMsg
{
    public uint ProtocolID;
    public uint RxStatus;
    public uint TxFlags;
    public uint Timestamp;
    public uint DataSize;
    public uint ExtraDataIndex;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 4128)]
    public byte[] Data;
}
