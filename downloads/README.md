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

On `www.shopcrank.com`, Pages owns the hostname and the Worker is attached only to `/api/*`. Windows installers therefore download from `/api/downloads/<file>`, which the Worker serves from R2 (`shopcrank-files`) as an attachment. It returns `404` when the file is missing from R2 and `503` when R2 is not bound, never the website shell. `public/_redirects` sends old `/downloads/ShopCrank-*Setup-*` links to the `/api/downloads/` path. The install page HTML and the committed APK still come from Pages.

Installer links in `index.html` and the in-app settings page must use `/api/downloads/` and the `package.json` version; `worker/test/download.test.mjs` fails when they drift.

GitHub Release:

- https://github.com/tinytim3271-wq/ShopCrank/releases/tag/desktop-v1.1.0 (private repository; not a public download link)

Manual R2 upload:

```bash
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Setup-1.1.0.exe" --remote --file path/to/exe --content-type application/octet-stream
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Setup-1.1.0.zip" --remote --file path/to/zip --content-type application/zip
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank-Offline-Setup-1.1.0.exe" --remote --file path/to/offline-exe --content-type application/octet-stream
npx wrangler r2 object put "shopcrank-files/downloads/ShopCrank.apk" --remote --file downloads/ShopCrank.apk --content-type application/vnd.android.package-archive
```
