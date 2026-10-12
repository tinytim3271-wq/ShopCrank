# Building Shop Crank Dispatch — Android APK

This project uses [Capacitor](https://capacitorjs.com/) to package the web app as a fully offline Android application. All app features work without an internet connection — data is stored locally on the device.

## Requirements

- **Node.js** 24+ and npm (matches CI and `package.json` `engines`)
- **Android Studio** (latest stable) with:
  - Android SDK Platform 35
  - Android SDK Build-Tools
  - A JDK 17+ (bundled with Android Studio)

---

## First-time setup

```bash
npm install
npm run sync
```

`npm run sync` copies the web assets into `www/`, then syncs them into the Android project under `android/app/src/main/assets/public/`.

---

## Build a debug APK (for sideloading / testing)

```bash
cd android
./gradlew assembleDebug
```

The APK is output to:
```
android/app/build/outputs/apk/debug/app-debug.apk
```

Transfer this file to your Android device and install it (you may need to enable **"Install unknown apps"** in Settings → Security).

---

## Build a release APK (for distribution)

1. Generate a signing keystore (one-time):
   ```bash
   keytool -genkey -v -keystore shopcrank.jks -keyalg RSA -keysize 2048 \
     -validity 10000 -alias shopcrank
   ```

2. Build the release APK:
   ```bash
   cd android
   ./gradlew assembleRelease
   ```

3. Sign and align with `apksigner` (or configure signing in `android/app/build.gradle`).

---

## Updating web content

Whenever you edit `src/`, `index.html`, `styles.css`, `theme.css`, or `diagnostics-ui.js`, re-run from the repo root:

```bash
npm run sync
```

Then rebuild the APK.

---

## App details

| Property | Value |
|---|---|
| App ID | `com.shopcrank.dispatch` |
| Min Android | 6.0 (API 23) |
| Target Android | 15 (API 35) |
| Offline storage | `localStorage` (device-local) |
| External dependencies | None — all assets bundled locally |
