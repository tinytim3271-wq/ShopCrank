/**
 * Print support for form and record views (modals) and for generated print
 * documents (invoices, job cards, statements, tax forms).
 */

export const PRINT_FONT_SIZE = '12pt';

/** Base print rules injected into generated print documents. */
export const PRINT_BASE_CSS = [
  '@media print{',
  `html,body{font-size:${PRINT_FONT_SIZE}!important;line-height:1.4}`,
  'body :not(h1):not(h2):not(h3):not(h4){font-size:inherit!important}',
  'h1{font-size:18pt!important}h2{font-size:15pt!important}h3,h4{font-size:13pt!important}',
  'table{page-break-inside:auto}tr{page-break-inside:avoid}',
  '}',
].join('');

export function withPrintBaseStyles(html) {
  const markup = String(html ?? '');
  if (markup.includes('data-print-base')) return markup;
  const style = `<style data-print-base>${PRINT_BASE_CSS}</style>`;
  if (/<\/head>/i.test(markup)) return markup.replace(/<\/head>/i, `${style}</head>`);
  if (/<html\b[^>]*>/i.test(markup)) return markup.replace(/<html\b[^>]*>/i, match => `${match}<head>${style}</head>`);
  if (/^\s*<!doctype[^>]*>/i.test(markup)) return markup.replace(/^\s*<!doctype[^>]*>/i, match => `${match}${style}`);
  return `${style}${markup}`;
}

/** Modals that are tools or destructive confirmations rather than forms/records. */
export const NON_PRINTABLE_MODALS = [
  '[data-no-print]',
  '.global-assistant-modal',
  '#record-removal-form',
  '#full-reset-form',
  '#onboarding-cleanup',
].join(',');

export function modalOffersPrint(modal) {
  if (!modal?.querySelector) return false;
  if (modal.matches?.(NON_PRINTABLE_MODALS)) return false;
  return Boolean(modal.querySelector('.modal-head') && modal.querySelector('.modal-body'));
}

/** Holder for actions placed beside the modal close button. */
export function modalHeadActions(modal) {
  const head = modal?.querySelector?.('.modal-head');
  if (!head) return null;
  const existing = head.querySelector(':scope > .modal-head-actions');
  if (existing) return existing;
  const doc = head.ownerDocument;
  const holder = doc.createElement('div');
  holder.className = 'modal-head-actions no-print';
  const close = head.querySelector(':scope > [data-close], :scope > .close');
  if (close) {
    close.before(holder);
    holder.append(close);
  } else {
    head.append(holder);
  }
  return holder;
}

export function addModalPrintButton(root, { onPrint, iconHtml = '' } = {}) {
  const modal = root?.querySelector?.('.modal') || null;
  if (!modalOffersPrint(modal) || modal.querySelector('[data-print-record]')) return null;
  const holder = modalHeadActions(modal);
  if (!holder) return null;
  const button = modal.ownerDocument.createElement('button');
  button.type = 'button';
  button.className = 'secondary modal-print';
  button.dataset.printRecord = '';
  button.title = 'Print this record';
  button.innerHTML = `${iconHtml}<span>Print</span>`;
  holder.prepend(button);
  modal.dataset.printable = 'true';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onPrint?.(modal);
  });
  return button;
}

/**
 * While a printable modal is open, print only that modal. Covers both the
 * Print button and the browser's own print command.
 */
export function installRecordPrintHooks(win = globalThis) {
  const doc = win.document;
  if (!doc || win.__shopcrankRecordPrintHooks) return;
  win.__shopcrankRecordPrintHooks = true;
  win.addEventListener('beforeprint', () => {
    const modal = doc.querySelector('#modal-root .modal[data-printable="true"]');
    doc.body.classList.toggle('printing-record', Boolean(modal));
  });
  win.addEventListener('afterprint', () => doc.body.classList.remove('printing-record'));
}

export function printRecordView(win = globalThis) {
  try {
    win.focus?.();
    win.print();
  } catch {
    /* Print dialog is unavailable in this host. */
  }
}
