const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { canOpenExternally, isTrustedNavigation } = require('./url-policy');

test('pop-ups only hand https ShopCrank pages to the system, never local files', () => {
  assert.equal(canOpenExternally('https://www.shopcrank.com/pricing'), true);
  assert.equal(canOpenExternally('file:///C:/Windows/System32/calc.exe'), false);
  assert.equal(canOpenExternally('file:///etc/passwd'), false);
  assert.equal(canOpenExternally('http://www.shopcrank.com/'), false);
  assert.equal(canOpenExternally('https://evil.example/'), false);
  assert.equal(canOpenExternally('javascript:alert(1)'), false);
  assert.equal(canOpenExternally('not a url'), false);
  assert.equal(canOpenExternally('https://www.shopcrank.com/', { demo: true }), false);
});

test('the window may load the app\'s own files but not other files on disk (POSIX)', () => {
  const appRoot = '/opt/ShopCrank/resources/app.asar';
  assert.equal(isTrustedNavigation('file:///opt/ShopCrank/resources/app.asar/index.html', { appRoot, pathApi: path.posix }), true);
  assert.equal(isTrustedNavigation('file:///opt/ShopCrank/resources/app.asar/index.html#/orders', { appRoot, pathApi: path.posix }), true);
  assert.equal(isTrustedNavigation('file:///opt/ShopCrank/resources/other.html', { appRoot, pathApi: path.posix }), false);
  assert.equal(isTrustedNavigation('file:///opt/ShopCrank/resources/app.asar/../evil.html', { appRoot, pathApi: path.posix }), false);
  assert.equal(isTrustedNavigation('file:///home/user/Downloads/invoice.html', { appRoot, pathApi: path.posix }), false);
});

test('Windows paths: app files allowed, downloads and other drives refused', () => {
  const appRoot = 'C:\\Program Files\\ShopCrank\\resources\\app.asar';
  const opts = { appRoot, pathApi: path.win32 };
  assert.equal(isTrustedNavigation('file:///C:/Program%20Files/ShopCrank/resources/app.asar/index.html', opts), true);
  assert.equal(isTrustedNavigation('file:///C:/Users/shop/Downloads/invoice.html', opts), false);
  assert.equal(isTrustedNavigation('file:///D:/index.html', opts), false);
});

test('https navigation keeps the trusted-origin list and is off in the demo', () => {
  assert.equal(isTrustedNavigation('https://www.shopcrank.com/app', { appRoot: '/app' }), true);
  assert.equal(isTrustedNavigation('https://accounts.google.com/o/oauth2', { appRoot: '/app' }), true);
  assert.equal(isTrustedNavigation('https://evil.example/', { appRoot: '/app' }), false);
  assert.equal(isTrustedNavigation('https://www.shopcrank.com/app', { appRoot: '/app', demo: true }), false);
});
