import { platform } from './detect.js';

/** Expose platform metadata for diagnostics and future module hooks. */
export function initPlatform() {
  window.__MECHPRO_PLATFORM__ = platform;
}

initPlatform();
