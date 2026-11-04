/**
 * Open a printable document and show the print dialog.
 * `window.open(..., "noopener")` still creates a tab but returns null, so the
 * invoice HTML never gets written and the user only sees a blank page.
 */

import { escapeHtml } from '../shared/html.js';
import { withPrintBaseStyles } from './record-print.js';

function resolveBaseHref(target) {
  const candidate = String(target?.document?.baseURI || target?.location?.href || '').trim();
  if (!candidate || /^(?:about|blob|data|javascript):/i.test(candidate)) return '';
  return candidate;
}

export function withBaseHref(html, target) {
  const markup = String(html ?? '');
  if (/<base\b/i.test(markup)) return markup;
  const baseHref = resolveBaseHref(target);
  if (!baseHref) return markup;
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  if (/<head\b[^>]*>/i.test(markup)) {
    return markup.replace(/<head\b[^>]*>/i, match => `${match}${baseTag}`);
  }
  if (/<html\b[^>]*>/i.test(markup)) {
    return markup.replace(/<html\b[^>]*>/i, match => `${match}<head>${baseTag}</head>`);
  }
  return `${baseTag}${markup}`;
}

function runPrint(win) {
  try {
    win.focus();
    win.print();
  } catch {
    /* Print dialog is unavailable in this host. */
  }
}

function armPrintControls(win, run) {
  const doc = win.document;
  if (!doc?.querySelectorAll) return;
  doc.querySelectorAll('button').forEach(button => {
    const replacement = button.cloneNode(true);
    replacement.removeAttribute('onclick');
    button.replaceWith(replacement);
    replacement.addEventListener('click', event => {
      event.preventDefault();
      run();
    });
  });
}

function schedulePrint(win, schedule, autoPrint) {
  let started = false;
  const run = () => runPrint(win);
  armPrintControls(win, run);
  if (!autoPrint) return;
  const start = () => {
    if (started) return;
    started = true;
    schedule(run);
  };
  if (win.document?.readyState === 'complete') {
    start();
    return;
  }
  win.addEventListener?.('load', start, { once: true });
}

function printInFrame(target, html, schedule, autoPrint) {
  const doc = target.document;
  if (!doc?.createElement || !doc.body) return false;
  const frame = doc.createElement('iframe');
  frame.setAttribute('title', 'Print');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:850px;height:1100px;border:0';
  doc.body.appendChild(frame);
  const childDoc = frame.contentDocument;
  const childWin = frame.contentWindow;
  if (!childDoc || !childWin) {
    frame.remove();
    return false;
  }
  childDoc.open();
  childDoc.write(String(html ?? ''));
  childDoc.close();
  const remove = () => frame.remove();
  childWin.addEventListener?.('afterprint', remove, { once: true });
  const fallback = setTimeout(remove, 120000);
  fallback.unref?.();
  schedulePrint(childWin, schedule, autoPrint);
  return true;
}

function openBlobDocument(target, html, schedule, autoPrint) {
  if (typeof target.Blob !== 'function' || typeof target.URL?.createObjectURL !== 'function') return false;
  const url = target.URL.createObjectURL(new target.Blob([String(html ?? '')], { type: 'text/html' }));
  let win = null;
  try {
    win = target.open?.(url, '_blank') ?? null;
  } catch {
    win = null;
  }
  const release = setTimeout(() => {
    try { target.URL.revokeObjectURL(url); } catch { /* already released */ }
  }, 60000);
  release.unref?.();
  if (!win) return false;
  try { win.opener = null; } catch { /* already severed */ }
  try {
    win.addEventListener('load', () => schedulePrint(win, schedule, autoPrint), { once: true });
  } catch {
    /* The invoice is already loaded in the new page. */
  }
  return true;
}

function openWritableDocument(target, html, schedule, autoPrint) {
  let win = null;
  try {
    win = target.open?.('', '_blank') ?? null;
  } catch {
    win = null;
  }
  if (!win?.document) return false;
  try {
    win.opener = null;
  } catch {
    /* The host already severed opener. */
  }
  try {
    win.document.open();
    win.document.write(String(html ?? ''));
    win.document.close();
    schedulePrint(win, schedule, autoPrint);
    return true;
  } catch {
    try { win.close(); } catch { /* already closed */ }
    return false;
  }
}

export function openPrintDocument(html, options = {}) {
  const target = options.windowObject || globalThis;
  const notify = options.toast || (() => {});
  const blockedMessage = options.blockedMessage || 'Allow pop-ups to print';
  const autoPrint = options.autoPrint !== false;
  const schedule = options.schedule || (fn => setTimeout(fn, 0));
  const markup = withBaseHref(withPrintBaseStyles(html), target);
  const blobAvailable = typeof target.Blob === 'function' && typeof target.URL?.createObjectURL === 'function';
  if (blobAvailable) {
    if (openBlobDocument(target, markup, schedule, autoPrint)) return true;
  } else if (openWritableDocument(target, markup, schedule, autoPrint)) return true;
  if (printInFrame(target, markup, schedule, autoPrint)) return true;
  notify(blockedMessage);
  return false;
}
