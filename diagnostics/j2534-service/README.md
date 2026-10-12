# J2534 Pass-Thru Host (Windows)

Native JSON-RPC named-pipe service used by the Shop Crank Windows desktop app for Dodge/Ram OEM diagnostics.

## Architecture

```
Shop Crank Electron → J2534.Host.exe (named pipe) → vendor J2534 DLL → USB adapter → vehicle CAN
```

## Build (Windows or Linux cross-publish)

```bash
# Linux / CI
./scripts/publish-win-x64.sh

# Windows PowerShell
./scripts/publish-win-x64.ps1
```

Output: `publish/win-x64/J2534.Host.exe` (self-contained .NET 8, win-x64).

## Requirements

- .NET 8 SDK
- Windows 10/11 x64 at runtime
- Vendor J2534 driver installed and registered in Windows (see below)
- USB J2534 Pass-Thru adapter

### Windows registry

Shop Crank scans these locations (most USB adapters, including TOPDON RLink X7, register under **WOW6432Node** on 64-bit Windows):

- `HKLM\SOFTWARE\PassThruSupport.04.04`
- `HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.04`
- `HKLM\SOFTWARE\PassThruSupport.04.02`
- `HKLM\SOFTWARE\WOW6432Node\PassThruSupport.04.02`

### TOPDON RLink X7

1. Install **RLink Platform** from TOPDON and register/activate the device.
2. In RLink Platform: **Drivers → Driver Download** — install the J2534 driver for your target OEM stack.
3. Plug the X7 into USB, wait for Windows to finish installing, then click **Refresh** in Shop Crank OEM Diagnostics.

## Simulator

Pass `adapterId: "simulator"` to use the bench ECU without hardware. Real adapters are enumerated from the Windows registry.

## Electron packaging

The Windows installer bundles `publish/win-x64/J2534.Host.exe` via `electron-builder` `extraResources`. Build the host **before** `npm run build:windows`.
