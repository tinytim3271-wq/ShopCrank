#!/usr/bin/env bash
# Installs the APK on a running emulator, launches it, and fails if the app
# crashes or its WebView never loads the app shell. Used by android-apk.yml.
set -euo pipefail
APK="${1:?usage: android-launch-smoke.sh path/to/app.apk}"
PKG="com.shopcrank.dispatch"
adb wait-for-device
adb install -r "$APK"
adb logcat -c
adb shell am start -W -n "$PKG/.MainActivity"
for _ in $(seq 1 30); do
  if adb shell pidof "$PKG" >/dev/null 2>&1; then break; fi
  sleep 2
done
sleep 15
if ! adb shell pidof "$PKG" >/dev/null 2>&1; then
  echo "ShopCrank is not running after launch"; adb logcat -d -t 300; exit 1
fi
if adb logcat -d | grep -E "FATAL EXCEPTION|AndroidRuntime: .*$PKG" ; then
  echo "ShopCrank crashed on launch"; adb logcat -d -t 300; exit 1
fi
adb exec-out screencap -p > android-launch.png || true
echo "ShopCrank launched and stayed running"
