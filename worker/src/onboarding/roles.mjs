// Creates the shop account (if the operator has not already) and the staff
// logins with ShopCrank's existing roles. The owner/authorized contact is an
// admin (full access, including accounting); everyone else gets the role from
// intake, and technicians are blocked from accounting by assistant/rbac.mjs.

import { syncAccessUser } from '../access-users.mjs';

export function planShopRoles(intake) {
  const owner = { name: `${intake.contact.firstName} ${intake.contact.lastName}`.trim(), email: intake.contact.email, role: 'admin' };
  const staff = intake.staff.filter(member => member.email !== owner.email);
  return { shopId: intake.shopId, shopName: intake.dbaName || intake.legalName, planId: intake.planId, users: [owner, ...staff] };
}

export async function provisionShopRoles(env, intake, { actor = 'onboarding' } = {}) {
  const plan = planShopRoles(intake);
  const now = new Date().toISOString();
  const [owner] = plan.users;
  const account = await env.DB.prepare('SELECT shop_id FROM accounts WHERE shop_id = ?').bind(plan.shopId).first();
  if (!account) {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO accounts (shop_id, shop_name, owner_email, owner_name, subscription_status, subscription_expires_at, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, 'trialing', NULL, ?, ?, ?)
      `).bind(plan.shopId, plan.shopName, owner.email, owner.name, now, now, actor),
      env.DB.prepare(`
        INSERT OR IGNORE INTO shops (id, name, slug, timezone, billing_status, created_at, updated_at)
        VALUES (?, ?, ?, 'America/Chicago', 'trialing', ?, ?)
      `).bind(plan.shopId, plan.shopName, plan.shopId, now, now),
      env.DB.prepare(`
        INSERT INTO subscriptions (shop_id, plan_id, status, current_period_end, updated_at)
        VALUES (?, ?, 'trialing', NULL, ?)
        ON CONFLICT(shop_id) DO NOTHING
      `).bind(plan.shopId, plan.planId || 'shop', now),
    ]);
  }
  const results = [];
  for (const member of plan.users) {
    try {
      const user = await syncAccessUser(env, { shopId: plan.shopId }, { ...member, active: true });
      results.push({ email: user.email, role: user.role, ok: true });
    } catch (error) {
      results.push({ email: member.email, role: member.role, ok: false, error: String(error?.message || error) });
    }
  }
  return { accountCreated: !account, users: results };
}
