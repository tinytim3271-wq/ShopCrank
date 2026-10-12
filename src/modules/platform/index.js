import { platform } from './detect.js';

/** Expose platform metadata for diagnostics and future module hooks. */
export function initPlatform() {
  window.__SHOP_CRANK_PLATFORM__ = platform;
}

initPlatform();
