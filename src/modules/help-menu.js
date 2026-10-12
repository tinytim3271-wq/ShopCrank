import { escapeAttr, escapeHtml } from '../shared/html.js';

/** @typedef {{ route: string, role: string, subview?: string, selectionLabel?: string }} HelpSnapshot */
/** @typedef {{ id: string, route: string, subview?: string, roles: string[], title: string, summary: string, steps: string[], limits: string[], keywords?: string[] }} HelpTopic */

const ALL_SHOP = ['admin', 'technician', 'office', 'service_writer'];
const COUNTER = ['admin', 'office', 'service_writer'];
const FLOOR = ['admin', 'technician', 'service_writer'];
const ADMIN_ONLY = ['admin'];
const OFFICE_BOOKS = ['admin', 'office'];
const TECH_PAY = ['admin', 'technician'];
const AI_ROLES = ['admin', 'technician', 'service_writer'];

/** @type {HelpTopic[]} */
export const HELP_TOPICS = [
  {
    id: 'login',
    route: 'login',
    roles: ['*'],
    title: 'Sign in',
    summary: 'Open MechPro with your work email. On the online site you get a sign-in link. The offline Windows app can use a local owner password.',
    steps: [
      'Enter your work email and request a sign-in link, or use Google when that button is shown.',
      'Open the email on this device and follow the link within fifteen minutes.',
      'On the offline desktop build, create or enter the local owner password when the form asks for it.',
    ],
    limits: [
      'An internet connection is required for cloud sign-in.',
      'The link only works for an email that belongs to this shop.',
    ],
    keywords: ['login', 'sign in', 'email', 'magic link', 'google'],
  },
  {
    id: 'pending-profile',
    route: 'pending-profile',
    roles: ['*'],
    title: 'Employee profile required',
    summary: 'Cloudflare Access accepted your identity, but this shop still needs an active employee row with the same email.',
    steps: [
      'Copy the email shown on the screen.',
      'Ask a shop administrator to open Employees and create or reactivate a profile with that exact email.',
      'Sign out and sign in again after the profile is active.',
    ],
    limits: [
      'MechPro will not invent an employee profile from Access alone for non-owner roles.',
    ],
    keywords: ['pending', 'employee', 'profile', 'deactivated'],
  },
  {
    id: 'superadmin',
    route: 'superadmin',
    roles: ['super_admin'],
    title: 'Platform console',
    summary: 'Manage customer shops on MechPro: create accounts, credits, suspension, and Stripe keys for a shop.',
    steps: [
      'Review the customer shop list and each shop’s subscription status.',
      'Create a shop with owner name, email, shop name, and shop ID when onboarding a customer.',
      'Open a shop’s Stripe integration only when you are ready to paste live keys for that shop.',
    ],
    limits: [
      'Platform admin cannot open a shop’s Card terminal or work-order screens from this console.',
      'Do not suspend shops or send mail unless that is the task you were given.',
    ],
    keywords: ['platform', 'shops', 'credits', 'suspend'],
  },
  {
    id: 'home',
    route: 'home',
    roles: ALL_SHOP,
    title: 'Home',
    summary: 'Start the shop day: open work, attention items, and shortcuts into intake and the counter.',
    steps: [
      'Scan today’s open jobs and overdue invoices.',
      'Start Customer intake when a vehicle arrives at the counter.',
      'Use a quick action to jump to Dispatch, Work orders, or Card terminal when your role allows it.',
    ],
    limits: [
      'Home does not replace the Dispatch board for bay assignment.',
    ],
    keywords: ['home', 'dashboard', 'today', 'intake'],
  },
  {
    id: 'dispatch',
    route: 'dispatch',
    roles: FLOOR,
    title: 'Dispatch board',
    summary: 'See active work by status lane and open a job card for the bay.',
    steps: [
      'Filter or search for a customer, vehicle, or RO number.',
      'Drag or open a job card to update status and technician.',
      'Open the work order when you need notes, photos, or the clock.',
    ],
    limits: [
      'Office staff do not have Dispatch in their menu.',
    ],
    keywords: ['dispatch', 'board', 'lanes', 'bay'],
  },
  {
    id: 'orders',
    route: 'orders',
    roles: FLOOR,
    title: 'Work orders',
    summary: 'List and open repair orders. Intake converts into an RO from the counter.',
    steps: [
      'Search or filter the work-order list.',
      'Open an RO to edit complaint, notes, assignments, and totals.',
      'Use Customer intake from Home when you need a guided arrival flow.',
    ],
    limits: [
      'Mitchell, ALLDATA, Motor, and ShopKey are not connected from this list.',
      'Office staff do not open Work orders from the menu.',
    ],
    keywords: ['work order', 'ro', 'orders', 'intake'],
  },
  {
    id: 'schedule',
    route: 'schedule',
    roles: FLOOR,
    title: 'Schedule',
    summary: 'Appointments and promised times for the shop calendar.',
    steps: [
      'Review the day or week for booked appointments.',
      'Open a slot or appointment to adjust time, tech, or vehicle.',
      'Link the visit back to a work order when the customer arrives.',
    ],
    limits: [
      'Schedule is not a full CRM campaign tool.',
    ],
    keywords: ['schedule', 'calendar', 'appointment'],
  },
  {
    id: 'customers',
    route: 'customers',
    roles: ['admin', 'office', 'service_writer'],
    title: 'Customers',
    summary: 'Customer cards with phone, email, vehicles, and balances.',
    steps: [
      'Search by name or phone.',
      'Open a customer to see vehicles, invoices, and payments.',
      'Add a customer before intake when they are new to the shop.',
    ],
    limits: [
      'Plate lookup stays off until a DMV or registration provider is connected.',
    ],
    keywords: ['customers', 'phone', 'email', 'vehicle'],
  },
  {
    id: 'invoices',
    route: 'invoices',
    roles: COUNTER,
    title: 'Invoices',
    summary: 'Accounts receivable: edit invoices, record cash or card receipts, and send a hosted pay link.',
    steps: [
      'Find the invoice by number or customer.',
      'Record cash or a card receipt when money was taken outside Checkout.',
      'Use Pay online when the customer will pay a Stripe Checkout link.',
    ],
    limits: [
      'Technicians do not see Invoices.',
      'Deleting an invoice also removes its payment history.',
    ],
    keywords: ['invoice', 'receivable', 'balance', 'pay online'],
  },
  {
    id: 'pos',
    route: 'pos',
    subview: 'reader',
    roles: COUNTER,
    title: 'Card terminal · Card reader',
    summary: 'Charge a work order or invoice on a Stripe Terminal reader at the counter.',
    steps: [
      'Confirm Stripe is connected on Payments and a reader is online.',
      'Select the work order or invoice with a balance.',
      'Enter the amount and send the charge to the reader. Stay on this screen until it shows paid or declined.',
      'Cancel on the reader from this screen if the customer walks away.',
    ],
    limits: [
      'Card numbers are never typed into MechPro on the reader path.',
      'Technicians do not have Card terminal.',
    ],
    keywords: ['pos', 'terminal', 'reader', 'card present', 'debit'],
  },
  {
    id: 'pos-phone',
    route: 'pos',
    subview: 'phone',
    roles: COUNTER,
    title: 'Card terminal · Phone order',
    summary: 'Take a card for a purchase made over the phone. Stripe’s form collects the number in the browser.',
    steps: [
      'Select Phone order, then choose the work order or invoice.',
      'Enter the amount and choose Enter card to open Stripe’s Payment Element.',
      'Type the card only in the Stripe fields. Confirm the charge when the form is complete.',
      'Keep this tab open until MechPro shows the payment recorded.',
    ],
    limits: [
      'Never paste a card number into a MechPro note, chat, or work-order field.',
      'Phone entry needs the publishable key saved on Payments.',
      'Mail-order / telephone (MOTO) may fall back to a normal keyed charge if Stripe has not enabled MOTO on the account.',
    ],
    keywords: ['phone', 'keyed', 'moto', 'manual card', 'over the phone'],
  },
  {
    id: 'chat',
    route: 'chat',
    roles: ALL_SHOP,
    title: 'Team chat',
    summary: 'Internal shop threads for the counter and the floor.',
    steps: [
      'Pick a conversation or start one for a job.',
      'Send updates the bay and office can both see.',
      'Do not put card numbers or passwords in chat.',
    ],
    limits: [
      'Chat is for the shop team, not customer SMS.',
    ],
    keywords: ['chat', 'messages', 'team'],
  },
  {
    id: 'shopops',
    route: 'shopops',
    roles: ALL_SHOP,
    title: 'Vehicles & parts',
    summary: 'Vehicles, inspections, inventory, ordering, canned services, reminders, and basic OBD tools.',
    steps: [
      'Choose a tab for vehicles, inspections, inventory, ordering, services, reminders, or diagnostics.',
      'Link a vehicle to a customer before intake when you can.',
      'Use canned services when building a quick estimate line.',
    ],
    limits: [
      'Plate lookup and Carfax stay off until those providers are connected.',
      'AutoZone Pro ordering needs a saved login on this screen.',
    ],
    keywords: ['shopops', 'vehicles', 'inventory', 'parts', 'inspections'],
  },
  {
    id: 'oem-diagnostics',
    route: 'oem-diagnostics',
    roles: FLOOR,
    title: 'OEM diagnostics',
    summary: 'Gateway and OEM diagnostic sessions for supported makes. Use the published host path for real vehicles.',
    steps: [
      'Confirm the pass-through and OEM tool path the shop uses for that make.',
      'Open the session from this bay only when the vehicle and authorization are ready.',
      'Record findings on the work order after the session.',
    ],
    limits: [
      'This screen does not unlock unofficial seed-to-key clients.',
      'AutoAuth covers supported Stellantis and certain Nissan, Infiniti, and Mercedes gateways — not every GM VIN.',
      'Live flash stays fail-closed. Do not run zero-byte firmware flashes.',
    ],
    keywords: ['oem', 'diagnostics', 'gateway', 'autoauth', 'j2534'],
  },
  {
    id: 'obd',
    route: 'obd',
    roles: FLOOR,
    title: 'OBD bay',
    summary: 'Shop-bay OBD tools tied to a repair order when the bay simulator or host is available.',
    steps: [
      'Select the work order for the vehicle in the bay.',
      'Run the scan the bay supports and copy codes into the RO notes.',
      'Verify safety-critical findings before releasing the vehicle.',
    ],
    limits: [
      'Simulated bay results are not a substitute for a live tool on a customer vehicle.',
    ],
    keywords: ['obd', 'codes', 'scan', 'bay'],
  },
  {
    id: 'keys',
    route: 'keys',
    roles: FLOOR,
    title: 'Key programming',
    summary: 'Key jobs that the shop bay allows when the repair order is authorized.',
    steps: [
      'Confirm the RO is authorized for key work.',
      'Choose the key operation the bay lists for that vehicle.',
      'Document the result on the work order.',
    ],
    limits: [
      'MechPro does not provide seed-key bypass, immobilizer cloning, or key-programming algorithms.',
      'Unsupported gateway or make combinations stay blocked.',
    ],
    keywords: ['keys', 'programming', 'fob', 'immobilizer'],
  },
  {
    id: 'ai',
    route: 'ai',
    roles: AI_ROLES,
    title: 'AI workbench',
    summary: 'Recommendations for workflow, diagnostics, estimates, guides, and phone intake. Verify before you act.',
    steps: [
      'Pick a tab for the kind of help you need.',
      'Review every recommendation on the vehicle and the RO before changing parts or promises.',
      'Save estimates only after a person checks the lines.',
    ],
    limits: [
      'Conversational AI stays off while AI_ENABLED is 0.',
      'AI does not replace OEM procedures or safety judgment.',
      'Mitchell, ALLDATA, Motor, and ShopKey are not connected here.',
    ],
    keywords: ['ai', 'estimate', 'diagnostics', 'guide', 'assistant'],
  },
  {
    id: 'employees',
    route: 'employees',
    roles: ADMIN_ONLY,
    title: 'Employees',
    summary: 'Shop users, roles, and active status for sign-in.',
    steps: [
      'Add an employee with the same email they use for Access or magic link.',
      'Set role to admin, office, service writer, or technician.',
      'Deactivate a profile when someone leaves; do not delete Access without updating this list.',
    ],
    limits: [
      'Technicians cannot manage employees.',
      'Pay rates are hidden from technicians on other screens.',
    ],
    keywords: ['employees', 'users', 'roles', 'access'],
  },
  {
    id: 'payroll',
    route: 'payroll',
    roles: TECH_PAY,
    title: 'Payroll',
    summary: 'Planning view for hours, flat rate, commission, and team split on work orders. This is not a filed tax return.',
    steps: [
      'Pick a pay period to review assignments and amounts.',
      'Confirm write-ins without an employee id stay at amount zero for payroll.',
      'Export or print only what your shop uses for its own records.',
    ],
    limits: [
      'Payroll figures are a planning estimate, not a legal W-2.',
      'Office staff do not see Payroll.',
      'Technicians can read their planning view; they cannot weaken payroll RBAC.',
    ],
    keywords: ['payroll', 'hours', 'commission', 'w-2', 'pay'],
  },
  {
    id: 'accounting',
    route: 'accounting',
    roles: OFFICE_BOOKS,
    title: 'Accounting',
    summary: 'Income, expenses, receivables, ledger, and chart of accounts for the shop books.',
    steps: [
      'Use the Overview tab for a quick profit and loss snapshot.',
      'Record expenses and journal entries from the action buttons.',
      'Export the ledger when you need a file for your bookkeeper.',
    ],
    limits: [
      'Technicians and service writers do not open Accounting.',
    ],
    keywords: ['accounting', 'ledger', 'expense', 'receivables'],
  },
  {
    id: 'reports',
    route: 'reports',
    roles: ADMIN_ONLY,
    title: 'Reports',
    summary: 'Shop performance and tax report packages the admin can generate.',
    steps: [
      'Choose the report range you need.',
      'Review totals against invoices and payments before sharing outside the shop.',
    ],
    limits: [
      'Reports do not file taxes for you.',
    ],
    keywords: ['reports', 'tax', 'performance'],
  },
  {
    id: 'imports',
    route: 'imports',
    roles: ADMIN_ONLY,
    title: 'Import data',
    summary: 'Bring customers, vehicles, or other supported lists into MechPro from a file.',
    steps: [
      'Pick the import type the screen lists.',
      'Preview rows before you confirm the write.',
      'Fix duplicates in Customers or Vehicles after the import.',
    ],
    limits: [
      'Unsupported columns are skipped rather than inventing values.',
    ],
    keywords: ['import', 'csv', 'upload'],
  },
  {
    id: 'messaging',
    route: 'messaging',
    roles: ADMIN_ONLY,
    title: 'Messaging',
    summary: 'Customer messaging setup and outbound tools the shop has connected.',
    steps: [
      'Confirm the messaging provider fields the shop uses.',
      'Send only to customers who asked for contact on that channel.',
    ],
    limits: [
      'Do not send unsolicited mail from MechPro.',
      'Email routing on the apex domain stays with Google Workspace MX.',
    ],
    keywords: ['messaging', 'sms', 'email'],
  },
  {
    id: 'payments',
    route: 'payments',
    roles: ADMIN_ONLY,
    title: 'Payments',
    summary: 'Connect this shop’s Stripe account: secret key, webhook signing secret, and publishable key.',
    steps: [
      'Paste the Stripe secret key and webhook signing secret together when first connecting.',
      'Add the publishable key so Phone order on Card terminal can open Stripe’s form.',
      'Copy the webhook URL into the Stripe Dashboard and include checkout.session.completed and payment_intent.succeeded.',
    ],
    limits: [
      'The browser never stores the secret key after save; it is encrypted on the Worker.',
      'Keys must be test or live as a matching pair.',
    ],
    keywords: ['stripe', 'payments', 'webhook', 'publishable', 'secret'],
  },
  {
    id: 'settings',
    route: 'settings',
    roles: ADMIN_ONLY,
    title: 'Settings',
    summary: 'Shop profile, theme, labor rate, AgentPhone, apps, and danger-zone data reset.',
    steps: [
      'Update shop name, phone, address, and rates the invoices use.',
      'Connect AgentPhone only with this shop’s API key and agent id.',
      'Use Remove all shop data only when you intend to wipe operational records.',
    ],
    limits: [
      'Full reset keeps users and subscription; it deletes customers, ROs, invoices, and related shop data.',
    ],
    keywords: ['settings', 'profile', 'theme', 'agentphone', 'reset'],
  },
];

const SUBVIEW_LABELS = Object.freeze({
  reader: 'Card reader',
  phone: 'Phone order',
  overview: 'Overview',
  receivables: 'Receivables',
  expenses: 'Expenses',
  ledger: 'General ledger',
  accounts: 'Chart of accounts',
  vehicles: 'Vehicles',
  inspections: 'Inspections',
  inventory: 'Inventory',
  ordering: 'Ordering',
  services: 'Canned services',
  reminders: 'Reminders',
  diagnostics: 'OBD-II',
  analytics: 'Analytics',
  workflow: 'RO workflow',
  estimate: 'Estimator',
  'saved-estimates': 'Estimates',
  guide: 'Repair guide',
});

/**
 * @param {string} role
 * @param {string[]} roles
 */
export function helpRoleAllowed(role, roles) {
  if (!Array.isArray(roles) || !roles.length) return false;
  if (roles.includes('*')) return true;
  return Boolean(role) && roles.includes(role);
}

/**
 * @param {HelpSnapshot} snapshot
 * @returns {HelpTopic}
 */
export function helpContext(snapshot) {
  const route = String(snapshot?.route || 'login');
  const subview = String(snapshot?.subview || '');
  const selectionLabel = String(snapshot?.selectionLabel || '').trim();
  let topic = HELP_TOPICS.find((item) => item.route === route && (item.subview || '') === subview);
  if (!topic) topic = HELP_TOPICS.find((item) => item.route === route && !item.subview);
  if (!topic) {
    topic = {
      id: 'unknown',
      route,
      roles: ['*'],
      title: 'This screen',
      summary: 'Help for this screen is not written yet.',
      steps: ['Use the sidebar to open a screen you know, or search Help for a topic name.'],
      limits: [],
    };
  }
  const tabLabel = SUBVIEW_LABELS[subview] || '';
  let summary = topic.summary;
  if (route === 'pos' && selectionLabel) {
    summary = `${summary} Selected: ${selectionLabel}.`;
  } else if (tabLabel && route !== 'pos') {
    summary = `${summary} Current tab: ${tabLabel}.`;
  }
  return {
    ...topic,
    summary,
    steps: [...topic.steps],
    limits: [...(topic.limits || [])],
  };
}

/**
 * @param {string} query
 * @param {string} role
 * @returns {HelpTopic[]}
 */
export function helpSearch(query, role) {
  const needle = String(query || '').trim().toLowerCase();
  const visible = HELP_TOPICS.filter((topic) => helpRoleAllowed(role || '', topic.roles));
  if (!needle) return visible;
  return visible.filter((topic) => {
    const hay = [
      topic.title,
      topic.summary,
      ...(topic.steps || []),
      ...(topic.limits || []),
      ...(topic.keywords || []),
      topic.route,
    ].join(' ').toLowerCase();
    return hay.includes(needle);
  });
}

/**
 * @param {HelpTopic} topic
 * @param {string} role
 */
export function helpCanJump(topic, role) {
  if (!topic?.route) return false;
  if (['login', 'pending-profile'].includes(topic.route)) return false;
  return helpRoleAllowed(role || '', topic.roles);
}

/**
 * @param {HelpSnapshot} snapshot
 */
export function helpContextKey(snapshot) {
  return [
    snapshot?.route || '',
    snapshot?.role || '',
    snapshot?.subview || '',
    snapshot?.selectionLabel || '',
  ].join('|');
}

const helpUi = {
  open: false,
  query: '',
  lastKey: '',
  keybound: false,
};

/**
 * @param {HelpSnapshot} snapshot
 * @param {{ onNavigate?: (route: string) => void, icon?: (name: string, size?: number) => string }} [deps]
 */
export function syncHelp(snapshot, deps = {}) {
  const host = typeof document !== 'undefined' ? document.querySelector('#help-root') : null;
  if (!host) return helpUi;

  const topic = helpContext(snapshot);
  const role = String(snapshot?.role || '');
  const key = helpContextKey(snapshot);
  const results = helpSearch(helpUi.query, role);
  const iconFn = typeof deps.icon === 'function'
    ? deps.icon
    : (name, size = 16) => `<i data-lucide="${escapeAttr(name)}" style="width:${size}px;height:${size}px"></i>`;

  const steps = topic.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
  const limits = topic.limits.length
    ? `<div class="help-limits"><h3>Limits on this screen</h3><ul>${topic.limits.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const resultRows = results.map((item) => {
    const jump = helpCanJump(item, role)
      ? `<button type="button" class="mini-action" data-help-jump="${escapeAttr(item.route)}">Open</button>`
      : '';
    return `<li><div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.summary)}</span></div>${jump}</li>`;
  }).join('');

  host.innerHTML = `
    <button type="button" class="help-float" id="help-open" aria-haspopup="dialog" aria-expanded="${helpUi.open ? 'true' : 'false'}" aria-controls="help-panel" title="Help">
      ${iconFn('circle-help', 16)}<span>Help</span>
    </button>
    <div class="help-panel" id="help-panel" role="dialog" aria-modal="false" aria-labelledby="help-title" ${helpUi.open ? '' : 'hidden'}>
      <div class="help-panel-head">
        <div>
          <div class="eyebrow">Help</div>
          <h2 id="help-title">${escapeHtml(topic.title)}</h2>
        </div>
        <button type="button" class="icon-button" id="help-close" aria-label="Close help">${iconFn('x', 16)}</button>
      </div>
      <p class="help-summary">${escapeHtml(topic.summary)}</p>
      <ol class="help-steps">${steps}</ol>
      ${limits}
      <label class="help-search">Search help
        <input id="help-search-input" type="search" value="${escapeAttr(helpUi.query)}" placeholder="Try card, payroll, intake" autocomplete="off" />
      </label>
      <ul class="help-results">${resultRows || '<li class="help-empty">No topics match for your role.</li>'}</ul>
    </div>
  `;

  const openButton = host.querySelector('#help-open');
  const closeButton = host.querySelector('#help-close');
  const panel = host.querySelector('#help-panel');
  const searchInput = host.querySelector('#help-search-input');

  const setOpen = (next) => {
    helpUi.open = Boolean(next);
    if (panel) panel.hidden = !helpUi.open;
    if (openButton) openButton.setAttribute('aria-expanded', helpUi.open ? 'true' : 'false');
    if (!helpUi.open && openButton) openButton.focus();
  };

  openButton?.addEventListener('click', () => setOpen(true));
  closeButton?.addEventListener('click', () => setOpen(false));
  searchInput?.addEventListener('input', (event) => {
    helpUi.query = String(event.target.value || '');
    syncHelp(snapshot, deps);
    queueMicrotask(() => document.querySelector('#help-search-input')?.focus());
  });
  host.querySelectorAll('[data-help-jump]').forEach((button) => {
    button.addEventListener('click', () => {
      const route = button.getAttribute('data-help-jump');
      if (route && typeof deps.onNavigate === 'function') deps.onNavigate(route);
    });
  });

  if (!helpUi.keybound && typeof document !== 'undefined') {
    helpUi.keybound = true;
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const tag = String(target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey && !typing) {
        event.preventDefault();
        helpUi.open = true;
        const live = document.querySelector('#help-panel');
        const btn = document.querySelector('#help-open');
        if (live) live.hidden = false;
        if (btn) btn.setAttribute('aria-expanded', 'true');
      }
      if (event.key === 'Escape' && helpUi.open) {
        helpUi.open = false;
        const live = document.querySelector('#help-panel');
        const btn = document.querySelector('#help-open');
        if (live) live.hidden = true;
        if (btn) {
          btn.setAttribute('aria-expanded', 'false');
          btn.focus();
        }
      }
    });
  }

  if (typeof globalThis.lucide?.createIcons === 'function') {
    globalThis.lucide.createIcons({ root: host });
  }

  helpUi.lastKey = key;
  return helpUi;
}

/** Test helper: reset panel UI state between cases. */
export function resetHelpUi() {
  helpUi.open = false;
  helpUi.query = '';
  helpUi.lastKey = '';
  helpUi.keybound = false;
}

export function getHelpUi() {
  return helpUi;
}
