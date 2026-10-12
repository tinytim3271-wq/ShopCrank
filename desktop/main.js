const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const diagnostics = require('./diagnostics-bridge');
const { resolveDesktopStart } = require('./start-url');
const { resolveAuthDeepLink } = require('./auth-deep-link');
const edition = require('./edition.json');
const vault = require('./local-vault');
const { configurePortableData } = require('./portable-data');

try {
  configurePortableData(app, edition);
} catch {
  dialog.showErrorBox('MechPro Demo needs a writable drive', 'Extract the entire demo ZIP to a writable folder on your flash drive. MechPro cannot create its data folder beside the executable.');
  app.exit(1);
}

let mainWindow = null;

const trustedOrigins = new Set([
  'https://www.yourcarguy806.com',
  'https://mechpro-dispatch.pages.dev',
  'https://accounts.google.com',
]);

function isTrustedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'file:' || (edition.demo !== true && trustedOrigins.has(url.origin));
  } catch {
    return false;
  }
}

function registerOfflineIpc() {
  if (edition.offline !== true) return;
  const handlers = {
    'local-auth:status': () => vault.accountStatus(app.getPath('userData')),
    'local-auth:create': (_event, payload) => vault.createAccount(app.getPath('userData'), payload || {}),
    'local-auth:sign-in': (_event, payload) => vault.signIn(app.getPath('userData'), payload || {}),
    'local-shop:load': () => vault.loadShop(app.getPath('userData')),
    'local-shop:save': (_event, snapshot) => vault.saveShop(app.getPath('userData'), snapshot || {}),
  };
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, result: await handler(_event, ...args) };
      } catch (error) {
        return { ok: false, error: error.message || 'Offline sign-in failed' };
      }
    });
  });
}

function registerDiagnosticsIpc() {
  const handlers = {
    'diagnostics:listAdapters': () => diagnostics.listAdapters(),
    'diagnostics:connect': (_e, params) => diagnostics.connect(params),
    'diagnostics:disconnect': () => diagnostics.disconnect(),
    'diagnostics:getConnectionStatus': () => diagnostics.getConnectionStatus(),
    'diagnostics:readVin': () => diagnostics.readVin(),
    'diagnostics:identifyEcus': () => diagnostics.identifyEcus(),
    'diagnostics:readDtcs': () => diagnostics.readDtcs(),
    'diagnostics:clearDtcs': (_e, params) => diagnostics.clearDtcs(params || {}),
    'diagnostics:securityAccess': (_e, params) => diagnostics.securityAccess(params || {}),
    'diagnostics:programKey': (_e, params) => diagnostics.programKey(params || {}),
    'diagnostics:obdSnapshot': () => diagnostics.obdSnapshot(),
    'diagnostics:obdClearDtcs': (_e, params) => diagnostics.obdClearDtcs(params || {}),
    'diagnostics:keyProcedureSupport': (_e, params) => diagnostics.keyProcedureSupport(params || {}),
    'diagnostics:codeModule': (_e, params) => diagnostics.codeModule(params || {}),
    'diagnostics:bidirectionalControl': (_e, params) => diagnostics.bidirectionalControl(params || {}),
    'diagnostics:flashModule': (_e, params) => diagnostics.flashModule(params || {}),
    'diagnostics:startLiveLog': () => diagnostics.startLiveLog(),
    'diagnostics:stopLiveLog': () => diagnostics.stopLiveLog(),
    'diagnostics:pollLiveLog': (_e, since) => diagnostics.pollLiveLog(since),
    'diagnostics:identifyVehicle': () => diagnostics.identifyVehicle(),
  };
  Object.entries(handlers).forEach(([channel, handler]) => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        if (edition.demo === true) throw new Error('Live vehicle diagnostics are not available in the USB demo.');
        return { ok: true, result: await handler(event, ...args) };
      } catch (error) {
        return { ok: false, error: error.message || 'Diagnostic operation failed' };
      }
    });
  });
}
function createWindow() {
  const smokeTest = process.argv.includes('--smoke-test');
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#18252b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [
        ...(edition.offline === true ? ['--mechpro-offline'] : []),
        ...(edition.portable === true ? ['--mechpro-portable'] : []),
        ...(edition.demo === true ? ['--mechpro-demo'] : []),
      ],
    },
  });

  if (edition.demo === true) {
    window.webContents.session.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
  }
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (edition.demo !== true && isTrustedUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });
  if (smokeTest) {
    window.webContents.once('did-finish-load', async () => {
      try {
        await window.webContents.executeJavaScript(`new Promise(resolve => {
          const ready = () => document.querySelector('.app-shell, .login-panel');
          if (ready()) return resolve();
          const observer = new MutationObserver(() => {
            if (ready()) { observer.disconnect(); clearTimeout(timeout); resolve(); }
          });
          const timeout = setTimeout(() => { observer.disconnect(); resolve(); }, 15000);
          observer.observe(document.getElementById('root'), { childList: true, subtree: true });
        })`);
        const result = await window.webContents.executeJavaScript(`({
          desktop: Boolean(window.mechproDesktop),
          diagnostics: Boolean(window.mechproDiagnostics),
          title: document.title,
          authenticated: Boolean(document.querySelector('.app-shell')),
          loginText: document.querySelector('.login-panel')?.innerText || ''
        })`);
        const portableData = !edition.portable || app.getPath('userData') === path.join(path.dirname(process.execPath), 'MechPro Demo Data');
        const passed = portableData && result.desktop
          && result.diagnostics
          && result.title.includes('MechPro')
          && (result.authenticated
            || /work email|continue securely|sign in/i.test(result.loginText));
        console.log(JSON.stringify({ smokeTest: passed ? 'passed' : 'failed', portableData, ...result }));
        app.exit(passed ? 0 : 1);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
    });
  }
  window.once('ready-to-show', () => window.show());

  // Packaged desktop must use the hosted HTTPS origin so magic-link auth and /api
  // calls are same-origin. Loading index.html via file:// made fetch('/api/...') fail
  // with TypeError: Failed to fetch. Use --smoke-test / --local-assets for file://.
  const start = resolveDesktopStart({ offline: edition.offline === true });
  mainWindow = window;
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  const initialDeepLink = findAuthDeepLink(process.argv);
  if (handleAuthDeepLink(initialDeepLink)) {
    return;
  }
  if (start.useLocalAssets) {
    void window.loadFile(path.join(__dirname, '..', 'index.html'));
  } else {
    void window.loadURL(start.remoteUrl);
  }
}

function findAuthDeepLink(argv) {
  return (argv || []).map(value => String(value).trim().replace(/^"|"$/g, '')).find(value => value.includes('mechpro://')) || '';
}

function handleAuthDeepLink(rawUrl) {
  if (edition.offline === true || !rawUrl || !mainWindow) return false;
  const callbackUrl = resolveAuthDeepLink(rawUrl, resolveDesktopStart().remoteUrl);
  if (!callbackUrl) return false;
  void mainWindow.loadURL(callbackUrl);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  return true;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', (_event, argv) => {
  handleAuthDeepLink(findAuthDeepLink(argv));
});
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleAuthDeepLink(url);
});

function registerWindowsProtocol() {
  if (process.platform !== 'win32' || edition.offline === true) return;
  const { spawnSync } = require('node:child_process');
  const command = `"${process.execPath}" "%1"`;
  spawnSync('reg', ['add', 'HKCU\\Software\\Classes\\mechpro', '/ve', '/d', 'URL:MechPro authentication', '/f'], { windowsHide: true });
  spawnSync('reg', ['add', 'HKCU\\Software\\Classes\\mechpro', '/v', 'URL Protocol', '/d', '', '/f'], { windowsHide: true });
  spawnSync('reg', ['add', 'HKCU\\Software\\Classes\\mechpro\\shell\\open\\command', '/ve', '/d', command, '/f'], { windowsHide: true });
}

if (edition.offline !== true) {
  if (process.defaultApp) {
    app.setAsDefaultProtocolClient('mechpro', process.execPath, [path.resolve(process.argv[1] || '.')]);
  } else {
    app.setAsDefaultProtocolClient('mechpro');
  }
  registerWindowsProtocol();
}

if (hasSingleInstanceLock) app.whenReady().then(() => {
  registerOfflineIpc();
  registerDiagnosticsIpc();
  // Do not auto-start the J2534 host — start on first user-initiated diagnostics action.
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => diagnostics.stopHost());
app.on('window-all-closed', () => app.quit());
