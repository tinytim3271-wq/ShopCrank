const { contextBridge, ipcRenderer } = require('electron');
const edition = {
  offline: process.argv.includes('--mechpro-offline'),
  portable: process.argv.includes('--mechpro-portable'),
  demo: process.argv.includes('--mechpro-demo'),
};

async function invoke(channel, params) {
  const response = await ipcRenderer.invoke(channel, params);
  if (!response?.ok) throw new Error(response?.error || 'Diagnostic IPC failed');
  return response.result;
}

const desktopApi = {
  platform: process.platform,
  version: process.versions.electron,
  offline: edition.offline === true,
  portable: edition.portable === true,
  demo: edition.demo === true,
};

if (edition.offline === true) {
  desktopApi.localAuth = Object.freeze({
    status: () => invoke('local-auth:status'),
    create: (payload) => invoke('local-auth:create', payload),
    signIn: (payload) => invoke('local-auth:sign-in', payload),
  });
  desktopApi.localShop = Object.freeze({
    load: () => invoke('local-shop:load'),
    save: (snapshot) => invoke('local-shop:save', snapshot),
  });
}

contextBridge.exposeInMainWorld('mechproDesktop', Object.freeze(desktopApi));

contextBridge.exposeInMainWorld('mechproDiagnostics', Object.freeze({
  listAdapters: () => invoke('diagnostics:listAdapters'),
  connect: (params) => invoke('diagnostics:connect', params),
  disconnect: () => invoke('diagnostics:disconnect'),
  getConnectionStatus: () => invoke('diagnostics:getConnectionStatus'),
  readVin: () => invoke('diagnostics:readVin'),
  identifyEcus: () => invoke('diagnostics:identifyEcus'),
  readDtcs: () => invoke('diagnostics:readDtcs'),
  clearDtcs: (params) => invoke('diagnostics:clearDtcs', params),
  securityAccess: (params) => invoke('diagnostics:securityAccess', params),
  programKey: (params) => invoke('diagnostics:programKey', params),
  codeModule: (params) => invoke('diagnostics:codeModule', params),
  bidirectionalControl: (params) => invoke('diagnostics:bidirectionalControl', params),
  flashModule: (params) => invoke('diagnostics:flashModule', params),
  startLiveLog: () => invoke('diagnostics:startLiveLog'),
  stopLiveLog: () => invoke('diagnostics:stopLiveLog'),
  pollLiveLog: (since) => invoke('diagnostics:pollLiveLog', since),
  identifyVehicle: () => invoke('diagnostics:identifyVehicle'),
  obdSnapshot: () => invoke('diagnostics:obdSnapshot'),
  obdClearDtcs: (params) => invoke('diagnostics:obdClearDtcs', params),
  keyProcedureSupport: (params) => invoke('diagnostics:keyProcedureSupport', params),
}));
