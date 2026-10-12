function escapeText(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export function isOfflineDesktop() {
  return Boolean(globalThis.window?.mechproDesktop?.offline && globalThis.window.mechproDesktop.localAuth);
}

export function offlineSession(account) {
  const expires = Math.floor(Date.now() / 1000) + (12 * 60 * 60);
  const email = String(account?.email || '').trim().toLowerCase();
  const name = String(account?.name || '').trim();
  return {
    claims: {
      sub: 'offline-pc',
      email,
      name,
      'custom:shopId': 'offline-pc',
      'custom:role': 'admin',
      exp: expires,
    },
    expiresAt: expires * 1000,
    offline: true,
  };
}

export function offlineLoginMarkup({ hasAccount, email, icon, portable = Boolean(globalThis.window?.mechproDesktop?.portable) }) {
  const mark = icon('wrench');
  const lock = icon('lock-keyhole', 15);
  const buttonIcon = icon(hasAccount ? 'log-in' : 'save', 16);
  const safeEmail = escapeText(email);
  const device = portable ? 'drive' : 'computer';
  const shortDevice = portable ? 'drive' : 'PC';
  const storage = portable ? 'MechPro Demo Data folder beside the executable on this drive' : 'MechPro Offline folder on this computer';
  const nameField = hasAccount ? '' : `<label for="offline-name">Your name</label><input id="offline-name" name="name" autocomplete="name" required minlength="2" maxlength="80" placeholder="Shop owner"/>`;
  const confirmField = hasAccount ? '' : `<label for="offline-confirm">Confirm password</label><input id="offline-confirm" name="confirm" type="password" autocomplete="new-password" required minlength="8"/>`;
  return `<main class="login-screen"><section class="login-panel"><div class="brand login-brand"><div class="brand-mark">${mark}</div><div><div class="brand-name">${portable ? 'MechPro Demo' : 'MechPro'}</div><small>Offline on this ${shortDevice}</small></div></div><div class="eyebrow">This ${device}</div><h1>${hasAccount ? `Sign in on this ${device}` : `Create this ${device}’s sign-in`}</h1><p>${hasAccount ? `The password check stays on this ${shortDevice}. Work orders, customers, and invoices open from this ${device} when the internet is down.` : `Choose a password for this ${shortDevice}. MechPro stores the sign-in check here and does not send the password to the cloud.`}</p><form id="login-form">${nameField}<label for="login-email">Work email</label><input id="login-email" name="email" type="email" autocomplete="username" required ${hasAccount ? `value="${safeEmail}"` : 'autofocus'} placeholder="you@yourshop.com"/><label for="offline-password">Password</label><input id="offline-password" name="password" type="password" autocomplete="${hasAccount ? 'current-password' : 'new-password'}" required minlength="8" ${hasAccount ? 'autofocus' : ''}/>${confirmField}<p class="login-error" id="login-error" hidden></p><button class="primary login-button" type="submit">${buttonIcon}${hasAccount ? 'Sign in' : `Save sign-in on this ${shortDevice}`}</button></form><div class="login-security">${lock}<span>Shop records for this copy are saved in the ${storage}.</span></div></section></main>`;
}

const SECRET_KEY = /^(password|passphrase|secret|token|apikey|api_key)$/i;

export function stripOfflineSecrets(value) {
  if (Array.isArray(value)) return value.map(stripOfflineSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = stripOfflineSecrets(item);
  }
  return out;
}

export function snapshotShop(state) {
  return stripOfflineSecrets(structuredClone(state));
}

export function applyShopSnapshot(state, snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const clean = stripOfflineSecrets(snapshot);
  for (const [key, value] of Object.entries(clean)) state[key] = value;
  return true;
}

export function ensureOfflineOwner(state, account) {
  const email = String(account?.email || '').trim().toLowerCase();
  const name = String(account?.name || email).trim();
  const users = Array.isArray(state.users) ? state.users : [];
  let user = users.find((item) => String(item?.email || '').trim().toLowerCase() === email);
  if (!user) {
    user = {
      id: 'user-offline-owner',
      name,
      email,
      role: 'admin',
      title: 'Owner',
      techName: '',
      active: true,
      employeeId: 'EMP-LOCAL',
      phone: '',
      address: '',
      startDate: new Date().toISOString().slice(0, 10),
      employmentType: 'Salary',
      payRate: 0,
      payFrequency: 'Biweekly',
      department: 'Management',
      emergencyContact: '',
      taxStatus: 'W-2',
    };
    state.users = [user, ...users];
  } else {
    user.name = name || user.name;
    user.active = true;
    if (!user.role) user.role = 'admin';
  }
  state.currentUserId = user.id;
  return user;
}
