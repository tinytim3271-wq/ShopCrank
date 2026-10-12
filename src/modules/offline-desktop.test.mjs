import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOfflineOwner, offlineLoginMarkup, snapshotShop } from './offline-desktop.js';

const icon = (name) => `<i>${name}</i>`;

test('offline sign-in markup asks for a local password and does not offer Google', () => {
  const create = offlineLoginMarkup({ hasAccount: false, email: '', icon });
  assert.match(create, /Save sign-in on this PC/);
  assert.match(create, /name="password"/);
  assert.match(create, /name="confirm"/);
  assert.doesNotMatch(create, /google|magic|sign-in link/i);
  const returning = offlineLoginMarkup({ hasAccount: true, email: 'lee@shop.test', icon });
  assert.match(returning, /value="lee@shop.test"/);
  assert.match(returning, /autocomplete="current-password"/);
  assert.doesNotMatch(returning, /value="[^"]*password/);
});

test('shop snapshots drop passwords and the owner profile matches the local account', () => {
  const snapshot = snapshotShop({
    orders: [{ id: 'RO-9' }],
    users: [{ id: 'user-1', email: 'lee@shop.test', password: 'secret-value' }],
  });

  assert.equal(snapshot.users[0].password, undefined);
  assert.equal(snapshot.orders[0].id, 'RO-9');
  const state = { users: [], currentUserId: null };
  const user = ensureOfflineOwner(state, { email: 'Lee@Shop.test', name: 'Lee Owner' });
  assert.equal(user.email, 'lee@shop.test');
  assert.equal(user.role, 'admin');
  assert.equal(state.currentUserId, user.id);
});

test('portable login explains drive-local storage without changing installed editions', () => {
  const markup = offlineLoginMarkup({ hasAccount: false, email: '', icon, portable: true });
  assert.match(markup, /MechPro Demo/);
  assert.match(markup, /Save sign-in on this drive/);
  assert.match(markup, /MechPro Demo Data folder beside the executable on this drive/);
  assert.doesNotMatch(markup, /this PC|this computer/);
  const returning = offlineLoginMarkup({ hasAccount: true, email: 'demo@shop.test', icon, portable: true });
  assert.match(returning, /Sign in on this drive/);
});
