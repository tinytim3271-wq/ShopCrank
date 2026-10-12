/**
 * Shared storage helpers — single source of truth for MechPro local keys.
 */
import { storageKeys } from '../shared/config.js';

export { storageKeys };

export function readJson(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function readDispatchState(fallback = null) {
  return readJson(storageKeys.dispatch, fallback);
}

export function writeDispatchState(value) {
  writeJson(storageKeys.dispatch, value);
}

export function readSession() {
  try {
    const raw = sessionStorage.getItem(storageKeys.session) || localStorage.getItem(storageKeys.session);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeSession(session) {
  sessionStorage.setItem(storageKeys.session, JSON.stringify(session));
  localStorage.removeItem(storageKeys.session);
}

export function clearSession() {
  sessionStorage.removeItem(storageKeys.session);
  localStorage.removeItem(storageKeys.session);
}
