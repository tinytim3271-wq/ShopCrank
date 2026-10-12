/**
 * Register feature modules before the legacy SPA loads.
 *
 * Platform modules wire the three repo surfaces together:
 *   - src/ (web PWA bundle)
 *   - desktop/ (Electron shell via window.mechproDesktop)
 *   - worker/ (Workers API + D1/R2/Workers AI; see src/shared/config.js)
 */
import './platform/index.js';
import * as storage from './storage.js';
import * as mileage from './mileage.js';
import { platform } from './platform/detect.js';
import { escapeAttr, escapeHtml } from '../shared/html.js';

export function registerModules() {
  window.__MECHPRO_MODULES__ = {
    storage,
    mileage,
    platform,
    html: { escapeAttr, escapeHtml },
  };
}

registerModules();
