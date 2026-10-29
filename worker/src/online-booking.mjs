import { HttpError, json } from './http.mjs';
import { BookingError, bookAppointment, loadBookingContext, nextAvailability, shopEntitled, validBookingDate } from './scheduling.mjs';
import { resolveTwilioShopConfig, sendSms } from './integrations/sms.mjs';
import { toE164 } from './customer-followups.mjs';
import { automatedSmsEnabled, onlineBookingEnabled } from './growth-flags.mjs';

/**
 * Public online booking, included on every plan:
 *   GET  /api/book/:shopId          booking page (no sign-in)
 *   GET  /api/book/:shopId/slots    open times
 *   POST /api/book/:shopId          book; rate limited per client IP
 * The shop turns it off in Settings (shopsettings/booking.enabled = false).
 * Off for every shop unless ONLINE_BOOKING_ENABLED is "1"; the confirmation
 * text also needs AUTOMATED_SMS_ENABLED.
 */

const RATE_LIMIT = Object.freeze({ windowMs: 15 * 60 * 1000, max: 6 });
const SHOP_ID = /^shop-[a-z0-9]{6,40}$|^[a-z0-9][a-z0-9-]{2,63}$/;

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function nonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/[+/=]/g, '');
}

async function activeShop(env, shopId) {
  if (!SHOP_ID.test(shopId)) return null;
  if (!(await shopEntitled(env, shopId, 'sms'))) return null;
  return env.DB.prepare('SELECT id, name FROM shops WHERE id = ?').bind(shopId).first();
}

async function enforceRateLimit(request, env, shopId, hash) {
  const ip = String(request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return;
  const windowStart = Math.floor(Date.now() / RATE_LIMIT.windowMs) * RATE_LIMIT.windowMs;
  const row = await env.DB.prepare(`
    INSERT INTO auth_rate_limits (bucket, window_start, request_count) VALUES (?, ?, 1)
    ON CONFLICT(bucket, window_start) DO UPDATE SET request_count = request_count + 1
    RETURNING request_count
  `).bind(`booking:${shopId}:${await hash(ip)}`, windowStart).first().catch(() => null);
  if (Number(row?.request_count || 0) > RATE_LIMIT.max) throw new HttpError(429, 'Too many booking attempts. Please call the shop.');
}

function bookingPage({ shopId, shopName, hoursText, services, token }) {
  const options = services.length
    ? services.map(service => `<option>${escapeHtml(service)}</option>`).join('') + '<option value="">Something else (describe below)</option>'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Book service · ${escapeHtml(shopName)}</title>
<style>:root{--ink:#14201c;--muted:#68766f;--line:#d9ddd8;--green:#1f654b}*{box-sizing:border-box}body{margin:0;padding:20px;background:#f3f1eb;color:var(--ink);font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:auto;background:#fff;border:1px solid var(--line);border-radius:10px;padding:22px}h1{margin:0 0 4px}p.sub{margin:0 0 16px;color:var(--muted)}label{display:block;margin:12px 0 4px;font-weight:700}input,select,textarea{width:100%;padding:11px;border:1px solid var(--line);border-radius:6px;font:inherit}.slots{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.slots button{padding:9px 13px;border:1px solid var(--line);border-radius:6px;background:#fff;font:inherit;cursor:pointer}.slots button.on{background:var(--green);color:#fff;border-color:var(--green)}button.primary{margin-top:18px;width:100%;min-height:48px;border:0;border-radius:6px;background:var(--green);color:#fff;font-weight:800;font-size:16px;cursor:pointer}.error{color:#a63f36}.done{padding:16px;background:#edf5ef;border-radius:8px}</style></head>
<body><main><h1>${escapeHtml(shopName)}</h1><p class="sub">Book a service appointment online.${hoursText ? ` Hours: ${escapeHtml(hoursText)}` : ''}</p>
<form id="book"><label for="name">Your name</label><input id="name" name="customerName" autocomplete="name" required maxlength="120">
<label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" autocomplete="tel" required maxlength="40">
<label for="email">Email (optional)</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254">
<label for="vehicle">Vehicle (year, make, model)</label><input id="vehicle" name="vehicle" required maxlength="160">
${options ? `<label for="service">Service</label><select id="service" name="service">${options}</select>` : ''}
<label for="notes">${options ? 'Anything else we should know?' : 'What do you need done?'}</label><textarea id="notes" name="notes" rows="3" maxlength="1000" ${options ? '' : 'required'}></textarea>
<label for="date">Day</label><input id="date" name="date" type="date" required><div class="slots" id="slots"></div>
<p class="error" id="error" hidden></p><button class="primary" type="submit">Book appointment</button></form></main>
<script nonce="${token}">
const api=${JSON.stringify(`/api/book/${shopId}`)},form=document.querySelector('#book'),slots=document.querySelector('#slots'),error=document.querySelector('#error');let time='';
const show=m=>{error.textContent=m;error.hidden=!m};
async function load(date){slots.textContent='Loading…';time='';const r=await fetch(api+'/slots'+(date?'?date='+date:''));const b=await r.json().catch(()=>({}));slots.textContent='';const day=(b.days||[]).find(d=>!date||d.date===date)||(b.days||[])[0];if(!day){slots.textContent='No openings that day. Try another day or call the shop.';return}if(!date){form.date.value=day.date}if(day.date!==form.date.value){slots.textContent='No openings that day. Next opening: '+day.date;return}for(const t of day.slots){const btn=document.createElement('button');btn.type='button';btn.textContent=new Date('1970-01-01T'+t+':00').toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});btn.onclick=()=>{time=t;slots.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===btn))};slots.append(btn)}}
form.date.addEventListener('change',()=>load(form.date.value));load('');
form.addEventListener('submit',async e=>{e.preventDefault();show('');if(!time)return show('Pick a time.');const data=Object.fromEntries(new FormData(form));const service=data.service||data.notes;const r=await fetch(api,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,service,time})});const b=await r.json().catch(()=>({}));if(!r.ok){show(b.message||b.error||'Could not book. Please call the shop.');if(r.status===409)load(form.date.value);return}document.querySelector('main').innerHTML='<div class="done"><h1>You\\'re booked</h1><p>'+new Date(b.date+'T12:00:00').toLocaleDateString([], {weekday:'long',month:'long',day:'numeric'})+' at '+new Date('1970-01-01T'+b.time+':00').toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})+'.'+(b.confirmationSent?' We\\'ll text you a confirmation.':' Save this time; call the shop if you need to change it.')+'</p></div>'});
</script></body></html>`;
}

export async function handlePublicBooking(request, env, segments, { hashValue, getSecret = null } = {}) {
  const shopId = decodeURIComponent(segments[1] || '');
  const action = segments[2] || '';
  if (!onlineBookingEnabled(env)) throw new HttpError(404, 'Online booking is not available for this shop');
  const shop = await activeShop(env, shopId);
  if (!shop) throw new HttpError(404, 'Online booking is not available for this shop');
  const context = await loadBookingContext(env, shopId);
  if (!context.onlineBookingEnabled) throw new HttpError(404, 'Online booking is not available for this shop');

  if (request.method === 'GET' && !action) {
    const token = nonce();
    return new Response(bookingPage({ shopId, shopName: context.shopName || shop.name, hoursText: context.hoursText, services: context.services, token }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; connect-src 'self'; script-src 'nonce-${token}'; form-action 'self'; frame-ancestors 'none'`,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (request.method === 'GET' && action === 'slots') {
    const date = new URL(request.url).searchParams.get('date') || '';
    return json({
      today: context.now.date,
      days: nextAvailability({ from: validBookingDate(date) ? date : '', hours: context.hours, appointments: context.appointments, config: context.config, now: context.now, days: 3 }),
    });
  }
  if (request.method === 'POST' && !action) {
    if (hashValue) await enforceRateLimit(request, env, shopId, hashValue);
    const text = await request.text();
    if (text.length > 8_000) throw new HttpError(413, 'Booking request is too large');
    let body;
    try { body = JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'Request body must be valid JSON'); }
    const phone = toE164(body.phone);
    if (!phone) throw new HttpError(400, 'Enter a valid mobile number');
    try {
      const { appointment } = await bookAppointment(env, shopId, { ...body, phone }, { source: 'online_booking', createdBy: 'online-booking' });
      let confirmationSent = false;
      try {
        const consent = await env.DB.prepare('SELECT status FROM sms_consent WHERE shop_id = ? AND phone = ?').bind(shopId, phone).first();
        const twilio = !automatedSmsEnabled(env) || consent?.status === 'opted_out' ? null : await resolveTwilioShopConfig(env, shopId, getSecret);
        if (twilio?.configured) {
          const text = `${context.shopName || shop.name}: you're booked for ${appointment.service} on ${appointment.date} at ${appointment.time}. Reply to this text if you need to change it.`;
          const result = await sendSms(env, { to: phone, body: text }, { config: twilio });
          confirmationSent = true;
          await env.DB.prepare(`
            INSERT OR IGNORE INTO customer_messages (id, shop_id, customer_id, work_order_id, phone, direction, body, provider, provider_message_id, message_type, status, created_at)
            VALUES (?, ?, ?, NULL, ?, 'outbound', ?, ?, ?, 'booking_confirmation', ?, ?)
          `).bind(`sms-${crypto.randomUUID()}`, shopId, appointment.customerId || null, phone, text, result.provider || 'twilio', result.messageSid || null, result.status || 'sent', new Date().toISOString()).run();
        }
      } catch {
        // Confirmation text is best-effort; the appointment is already on the calendar.
      }
      return json({ booked: true, id: appointment.id, date: appointment.date, time: appointment.time, confirmationSent }, 201);
    } catch (error) {
      if (error instanceof BookingError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }
  throw new HttpError(405, 'Method not allowed');
}
