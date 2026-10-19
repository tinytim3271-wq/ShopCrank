import test from 'node:test';
import assert from 'node:assert/strict';
import { isApiPath, isApiRequest, pagesProxyUrl, publicDownloadObjectKey } from '../src/routing.mjs';

test('API paths stay on the Worker route', () => {
  assert.equal(isApiPath('/api'), true);
  assert.equal(isApiPath('/api/healthz'), true);
  assert.equal(isApiPath('/api/auth/session'), true);
  assert.equal(isApiPath('/app'), false);
  assert.equal(isApiPath('/'), false);
  assert.equal(isApiPath('/login'), false);
  assert.equal(isApiRequest(new Request('https://www.shopcrank.com/api/healthz')), true);
  assert.equal(isApiRequest(new Request('https://www.shopcrank.com/')), false);
});

test('non-API requests proxy to the Pages origin', () => {
  assert.equal(
    pagesProxyUrl('https://www.shopcrank.com/login', 'https://shopcrank-dispatch.pages.dev'),
    'https://shopcrank-dispatch.pages.dev/login',
  );
  assert.equal(
    pagesProxyUrl('https://www.shopcrank.com/app?tab=home', 'https://shopcrank-dispatch.pages.dev/'),
    'https://shopcrank-dispatch.pages.dev/app?tab=home',
  );
});

test('public download paths map to R2 object keys', () => {
  assert.equal(publicDownloadObjectKey('/downloads/MechPro-Setup-1.0.0.exe'), 'downloads/MechPro-Setup-1.0.0.exe');
  assert.equal(publicDownloadObjectKey('/downloads/MechPro-Setup-1.0.0.zip'), 'downloads/MechPro-Setup-1.0.0.zip');
  assert.equal(publicDownloadObjectKey('/downloads/MechPro.apk'), 'downloads/MechPro.apk');
  assert.equal(publicDownloadObjectKey('/downloads/'), null);
  assert.equal(publicDownloadObjectKey('/downloads/index.html'), null);
  assert.equal(publicDownloadObjectKey('/downloads/../secret.exe'), null);
  assert.equal(publicDownloadObjectKey('/app/MechPro.apk'), null);
});

test('/api/downloads paths map to the same R2 keys so the /api/* Worker route can serve installers', () => {
  assert.equal(publicDownloadObjectKey('/api/downloads/ShopCrank-Setup-1.1.0.exe'), 'downloads/ShopCrank-Setup-1.1.0.exe');
  assert.equal(publicDownloadObjectKey('/api/downloads/ShopCrank-Setup-1.1.0.zip'), 'downloads/ShopCrank-Setup-1.1.0.zip');
  assert.equal(publicDownloadObjectKey('/api/downloads/ShopCrank-Offline-Setup-1.1.0.exe'), 'downloads/ShopCrank-Offline-Setup-1.1.0.exe');
  assert.equal(publicDownloadObjectKey('/api/downloads/'), null);
  assert.equal(publicDownloadObjectKey('/api/downloads/%2e%2e%2fsecret.exe'), null);
  assert.equal(publicDownloadObjectKey('/api/downloads/%E0%A4%A.exe'), null);
  assert.equal(publicDownloadObjectKey('/api/downloads/secret.txt'), null);
});
