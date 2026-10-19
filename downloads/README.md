# ShopCrank app downloads

## Public install page

- https://www.shopcrank.com/downloads/
- https://shopcrank-dispatch.pages.dev/downloads/

## Binaries

| File | Source |
| --- | --- |
| `ShopCrank.apk` | Committed under `downloads/` and also mirrored to R2 `downloads/ShopCrank.apk` |
| `ShopCrank-Setup-*.exe` / `.zip` | **Not** in git (too large). Published by `windows-desktop.yml` to R2 and GitHub Releases |
| `ShopCrank-Offline-Setup-*.exe` | **Not** in git. Built with `npm run build:windows:offline` and published by `windows-desktop.yml` to R2 and GitHub Releases |

On `www.shopcrank.com`, the Worker serves `/downloads/*.{exe,zip,apk}` from R2 (`shopcrank-files`) before proxying other paths to Pages. The install page HTML still comes from Pages. A binary missing from R2 falls back to a non-HTML file on Pages (the committed APK); otherwise the Worker returns `404` (or `503` when R2 is not bound) instead of the website shell.

Installer links in `index.html` and the in-app settings page use the `package.json` version; `worker/test/download.test.mjs` fails when they drift.

GitHub Release:

- https://github.com/tinytim3271-wq/cloudflare/releases/tag/desktop-v1.1.0

Manual R2 upload:

```bash
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Setup-1.1.0.exe" --remote --file path/to/exe --content-type application/octet-stream
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Setup-1.1.0.zip" --remote --file path/to/zip --content-type application/zip
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Offline-Setup-1.1.0.exe" --remote --file path/to/offline-exe --content-type application/octet-stream
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank.apk" --remote --file downloads/ShopCrank.apk --content-type application/vnd.android.package-archive
```
