/** Detect whether the bundled app runs inside Electron (desktop/) or a browser tab. */
export const isDesktopApp = Boolean(window.shopcrankDesktop);
export const DESKTOP_ENTITLEMENT_INTERVAL = 5 * 60 * 1000;

export const platform = Object.freeze({
  kind: isDesktopApp ? 'desktop' : 'web',
  isDesktop: isDesktopApp,
  isWeb: !isDesktopApp,
  electronVersion: window.shopcrankDesktop?.version ?? null,
  os: window.shopcrankDesktop?.platform ?? null,
});
