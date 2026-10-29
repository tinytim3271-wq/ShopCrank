/**
 * Deploy-time switches for customer-facing automation. Each is off unless the
 * Worker var is exactly "1" (wrangler.jsonc `vars`, `wrangler secret put`, or
 * the Cloudflare dashboard), so merging or deploying never starts it.
 *
 *  AUTOMATED_SMS_ENABLED     Daily service-reminder and Google review-request
 *                            texts (cron and "Send due follow-ups now"), and
 *                            online-booking confirmation texts. Leave off until
 *                            the A2P 10DLC campaign is approved.
 *  ONLINE_BOOKING_ENABLED    Public booking page at /api/book/:shopId.
 *  AI_PHONE_BOOKING_ENABLED  Grok phone agent's availability and booking tools.
 */
const on = (env, name) => String(env?.[name] ?? '').trim() === '1';

export const automatedSmsEnabled = env => on(env, 'AUTOMATED_SMS_ENABLED');
export const onlineBookingEnabled = env => on(env, 'ONLINE_BOOKING_ENABLED');
export const aiPhoneBookingEnabled = env => on(env, 'AI_PHONE_BOOKING_ENABLED');
