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
  assert.equal(isApiRequest(new Request('https://www.yourcarguy806.com/api/healthz')), true);
  assert.equal(isApiRequest(new Request('https://www.yourcarguy806.com/')), false);
});

test('non-API requests proxy to the Pages origin', () => {
  assert.equal(
    pagesProxyUrl('https://www.yourcarguy806.com/login', 'https://mechpro-dispatch.pages.dev'),
    'https://mechpro-dispatch.pages.dev/login',
  );
  assert.equal(
    pagesProxyUrl('https://www.yourcarguy806.com/app?tab=home', 'https://mechpro-dispatch.pages.dev/'),
    'https://mechpro-dispatch.pages.dev/app?tab=home',
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
