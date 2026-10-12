/** Shop AutoZone Pro ordering. Credentials stay on the Worker; this module only builds links and the panel. */

export const AUTOZONE_PRO_LOGIN = 'https://www.autozonepro.com/ui/login';

export function autozoneProLoginUrl(keyword = '') {
  const term = String(keyword || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  const destination = new URL('/ui/product-results', 'https://www.autozonepro.com');
  if (term) destination.searchParams.set('searchKeyword', term);
  const url = new URL(AUTOZONE_PRO_LOGIN);
  url.searchParams.set('originalURL', `${destination.pathname}${destination.search}`);
  return url.toString();
}

export function orderingPanelHtml(account = {}, { canSave = false, escapeHtml, icon }) {
  const connected = Boolean(account.connected && account.username);
  const status = connected
    ? `<div class="messaging-status ready">${icon('circle-check', 17)}<div><strong>AutoZone Pro login saved</strong><span>${escapeHtml(account.username)}</span></div></div>`
    : `<div class="messaging-status idle">${icon('lock', 17)}<div><strong>No AutoZone Pro login saved</strong><span>An owner or admin can store the shop username and password. MechPro encrypts them and does not put them on the work order.</span></div></div>`;
  const form = canSave
    ? `<form id="autozone-login-form" class="form-grid">
        <label>Username<input name="username" autocomplete="off" value="${escapeHtml(account.username || '')}" required /></label>
        <label>Password<input name="password" type="password" autocomplete="new-password" required /></label>
        <button class="primary" type="submit">${icon('save', 14)} Save AutoZone Pro login</button>
        ${connected ? `<button class="secondary danger" type="button" id="autozone-disconnect">${icon('log-out', 14)} Remove saved login</button>` : ''}
      </form>`
    : '<p class="ops-note">Ask an owner or admin to save the shop AutoZone Pro login.</p>';
  const unavailable = account.unavailable
    ? '<p class="login-error">Sign in to the shop account to store or copy the AutoZone Pro login.</p>'
    : '';
  return `<section class="settings-panel autozone-ordering">
      <div class="statement-head"><div><div class="eyebrow">Parts ordering</div><h2>AutoZone Pro</h2><p>Open the shop's AutoZone Pro account from MechPro. After you open it, paste the saved password on AutoZone's sign-in page. Ordering, pricing, and checkout stay on AutoZone Pro.</p></div>${icon('shopping-cart', 20)}</div>
      ${status}
      ${unavailable}
      ${form}
      <form id="autozone-search-form" class="form-grid">
        <label class="full">Part search<input name="keyword" placeholder="canister purge valve pump" /></label>
        <button class="primary" type="submit">${icon('search', 14)} Search on AutoZone Pro</button>
        <button class="secondary" type="button" id="autozone-open">${icon('external-link', 14)} Open AutoZone Pro</button>
      </form>
    </section>`;
}
