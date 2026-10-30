// Operator alerts for onboarding (A2P status changes, failed test calls).
// Stored on the onboarding record and emailed to ONBOARDING_ALERT_EMAIL when set.

export async function raiseOnboardingAlert(env, onboarding, { level = 'info', kind, message }) {
  const alert = { at: new Date().toISOString(), level, kind, message };
  onboarding.state.alerts = [alert, ...(onboarding.state.alerts || [])].slice(0, 50);
  const to = String(env?.ONBOARDING_ALERT_EMAIL || '').trim();
  const from = String(env?.SUPPORT_EMAIL_FROM || env?.AUTH_EMAIL_FROM || '').trim();
  if (to && from && typeof env?.EMAIL?.send === 'function') {
    try {
      await env.EMAIL.send({ to, from, subject: `[ShopCrank onboarding] ${onboarding.shopId}: ${kind}`, text: `${message}\n\nShop: ${onboarding.shopId}\nLevel: ${level}` });
      alert.emailed = true;
    } catch (error) {
      alert.emailError = String(error?.message || error).slice(0, 120);
    }
  }
  console.log(JSON.stringify({ message: 'onboarding alert', shopId: onboarding.shopId, level, kind, detail: message }));
  return alert;
}
