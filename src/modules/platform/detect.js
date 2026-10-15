/** Detect whether the bundled app runs inside Electron (desktop/) or a browser tab. */
export function getDesktopBridge() {
  if (typeof window === 'undefined') return undefined;
  return window.shopcrankDesktop || window.mechproDesktop;
}

export const isDesktopApp = Boolean(getDesktopBridge());
export const DESKTOP_ENTITLEMENT_INTERVAL = 5 * 60 * 1000;

const desktop = getDesktopBridge();

export const platform = Object.freeze({
  kind: isDesktopApp ? 'desktop' : 'web',
  isDesktop: isDesktopApp,
  isWeb: !isDesktopApp,
  electronVersion: desktop?.version ?? null,
  os: desktop?.platform ?? null,
});
