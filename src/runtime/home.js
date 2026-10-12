/**
 * Home dashboard model for MechPro.
 * Pure data assembly so the landing view always has metrics, attention
 * items, today's work, and recent activity — even when the shop is empty.
 */

import { escapeAttr, escapeHtml } from '../shared/html.js';

export { escapeAttr, escapeHtml };

const CLOSED = new Set(['completed', 'invoiced', 'declined', 'archived']);

export function emptyState(message) {
  return `<div class="empty-state"><h2>${escapeHtml(message)}</h2></div>`;
}

export function greetingForNow(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function localIsoDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isTodayPromise(promise) {
  return /^today\b/i.test(String(promise || ''));
}

export function buildHomeModel({
  orders = [],
  invoices = [],
  appointments = [],
  now = new Date(),
} = {}) {
  const open = orders.filter((order) => !CLOSED.has(order.status));
  const inProgress = orders.filter((order) => order.status === 'in_progress');
  const waiting = orders.filter((order) => order.status === 'waiting_parts');
  const overdue = invoices.filter((invoice) => invoice.status === 'overdue');
  const unassigned = open.filter((order) => !order.tech || order.tech === 'Unassigned');
  const todayKey = localIsoDate(now);
  const promiseToday = open.filter((order) => isTodayPromise(order.promise));
  const seen = new Set(promiseToday.map((order) => order.id));
  const todayJobs = [
    ...promiseToday,
    ...inProgress.filter((order) => !seen.has(order.id)),
  ];
  const todaysAppointments = appointments.filter(
    (item) => item.date === todayKey && item.status !== 'cancelled',
  );
  const attention = [
    ...waiting.map((order) => ({
      id: order.id,
      type: 'parts',
      title: `${order.id} is waiting on parts`,
      detail: `${order.customer} · ${order.vehicle}`,
      orderId: order.id,
    })),
    ...unassigned.map((order) => ({
      id: `${order.id}-assign`,
      type: 'assign',
      title: `${order.id} needs a technician`,
      detail: order.complaint || order.vehicle,
      orderId: order.id,
    })),
    ...overdue.map((invoice) => ({
      id: invoice.number || invoice.id,
      type: 'overdue',
      title: `${invoice.number || invoice.id} is overdue`,
      detail: `${invoice.customer} · ${Number(invoice.amount || 0)}`,
      invoiceId: invoice.number || invoice.id,
      amount: Number(invoice.amount || 0),
    })),
  ];
  const activity = [
    ...open.map((order) => ({
      id: order.id,
      title: order.id,
      status: order.status,
      customer: order.customer,
      vehicle: order.vehicle,
      meta: order.promise,
      orderId: order.id,
    })),
    ...invoices.map((invoice) => ({
      id: invoice.number || invoice.id,
      title: invoice.number || invoice.id,
      status: invoice.status,
      customer: invoice.customer,
      vehicle: invoice.ro,
      meta: invoice.date,
    })),
  ].slice(0, 8);

  return {
    openCount: open.length,
    inProgressCount: inProgress.length,
    waitingCount: waiting.length,
    overdueCount: overdue.length,
    overdueTotal: overdue.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0),
    paidTotal: invoices
      .filter((invoice) => invoice.status === 'paid')
      .reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0),
    todayJobs,
    todaysAppointments,
    attention: attention.slice(0, 8),
    activity,
    isEmpty: orders.length === 0 && invoices.length === 0,
  };
}

export function mergeRemoteCollection(key, remote, local, isSampleRecord, pendingCreateIds = []) {
  if (!Array.isArray(remote)) return Array.isArray(local) ? local : [];
  const current = Array.isArray(local) ? local : [];
  const pendingIds = new Set(pendingCreateIds);
  if (!remote.length) {
    if (current.length && typeof isSampleRecord === 'function' && current.every((record) => isSampleRecord(key, record))) {
      return current;
    }
    const pendingCreates = current.filter((record) => record?.id && pendingIds.has(record.id));
    return pendingCreates.length ? pendingCreates : remote;
  }
  // Keep queued creates that are not yet present in the authoritative remote list.
  const remoteIds = new Set(remote.map((record) => record?.id).filter(Boolean));
  const localOnly = current.filter((record) => (
    record?.id
    && !remoteIds.has(record.id)
    && pendingIds.has(record.id)
  ));
  return localOnly.length ? [...localOnly, ...remote] : remote;
}

export function pendingCreateIdsForCollection(collection, queue = [], entityCollections = {}) {
  return (Array.isArray(queue) ? queue : []).flatMap((item) => {
    if (item?.method !== 'POST') return [];
    const type = String(item.path || '').match(/^\/entities\/([^/]+)/i)?.[1]?.toLowerCase();
    const target = type && Object.prototype.hasOwnProperty.call(entityCollections, type)
      ? entityCollections[type]
      : type;
    if (target !== collection) return [];
    try {
      const id = JSON.parse(item.body)?.id;
      return id ? [id] : [];
    } catch {
      return [];
    }
  });
}

export function coalesceQueuedEntityMutation(existing, incoming) {
  const preserveCreate = existing?.method === 'POST' && incoming.method === 'PUT';
  return {
    path: preserveCreate ? existing.path : incoming.path,
    method: preserveCreate ? 'POST' : incoming.method,
    body: incoming.body,
    expectedUpdatedAt: preserveCreate ? null : incoming.expectedUpdatedAt || null,
  };
}

/** Plain-language navigation. Order is the shop day: today, counter, floor, office. */
export const sidebarCatalog = [
  {
    label: 'Today',
    items: [
      { route: 'home', icon: 'house', label: 'Home' },
      { route: 'dispatch', icon: 'layout-dashboard', label: 'Dispatch board', count: 'active' },
      { route: 'schedule', icon: 'calendar-days', label: 'Schedule' },
    ],
  },
  {
    label: 'Front counter',
    items: [
      { route: 'orders', icon: 'clipboard-list', label: 'Work orders', count: 'orders' },
      { route: 'customers', icon: 'users', label: 'Customers' },
      { route: 'invoices', icon: 'receipt-text', label: 'Invoices', count: 'overdue' },
      { route: 'pos', icon: 'credit-card', label: 'Card terminal' },
      { route: 'chat', icon: 'messages-square', label: 'Team chat', count: 'unread' },
    ],
  },
  {
    label: 'Shop floor',
    items: [
      { route: 'shopops', icon: 'blocks', label: 'Vehicles & parts' },
      { route: 'oem-diagnostics', icon: 'radio-tower', label: 'OEM diagnostics', requiresOem: true },
      { route: 'obd', icon: 'activity', label: 'OBD bay' },
      { route: 'keys', icon: 'key', label: 'Key programming' },
      { route: 'ai', icon: 'sparkles', label: 'AI workbench' },
    ],
  },
  {
    label: 'Back office',
    items: [
      { route: 'employees', icon: 'user-round-cog', label: 'Employees' },
      { route: 'payroll', icon: 'wallet-cards', label: 'Payroll' },
      { route: 'accounting', icon: 'landmark', label: 'Accounting' },
      { route: 'reports', icon: 'chart-no-axes-combined', label: 'Reports' },
      { route: 'imports', icon: 'file-up', label: 'Import data' },
      { route: 'messaging', icon: 'message-square-more', label: 'Messaging' },
      { route: 'payments', icon: 'credit-card', label: 'Payments' },
      { route: 'integrations', icon: 'plug-zap', label: 'Integrations' },
      { route: 'support', icon: 'life-buoy', label: 'Help & support' },
      { route: 'settings', icon: 'settings', label: 'Settings' },
    ],
  },
];

export function visibleSidebar(canAccess, { oem = false } = {}) {
  return sidebarCatalog
    .map((section) => ({
      label: section.label,
      items: section.items.filter((item) => (!item.requiresOem || oem) && canAccess(item.route)),
    }))
    .filter((section) => section.items.length > 0);
}

if (typeof globalThis !== 'undefined') {
  globalThis.__MECHPRO_HOME__ = {
    buildHomeModel,
    emptyState,
    escapeHtml,
    greetingForNow,
    localIsoDate,
    mergeRemoteCollection,
    pendingCreateIdsForCollection,
    coalesceQueuedEntityMutation,
    sidebarCatalog,
    visibleSidebar,
  };
}
