'use strict';

// Abandoned-cart recovery emails — runs hourly from server.js, same pattern
// as invoiceReminders.js. Two reminders per cart, sent once each:
//   1st — 1 hour after the cart was last touched (still not recovered)
//   2nd — 24 hours after the cart was last touched (a last nudge)
// Never a third reminder — remindersSent caps out at 2 and is simply
// skipped after that until the document expires via its TTL index.
const AbandonedCart = require('../models/AbandonedCart');
const Company = require('../models/Company');
const emailService = require('../services/emailService');
const logger = require('./logger');

const HOUR = 60 * 60 * 1000;
const clientUrl = () => (process.env.CLIENT_URL || 'https://bislyai.com').split(',')[0].trim().replace(/\/+$/, '');
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

function reminderEmail(company, cart, recoverUrl) {
  const rows = cart.items.map((i) => `
    <tr>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;">${i.name}${i.variantValue ? ` (${i.variantValue})` : ''} × ${i.quantity}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:14px;text-align:right;">${naira(i.price * i.quantity)}</td>
    </tr>`).join('');

  const html = emailService.baseTemplate('You left something behind', `
    <h2 style="color:#0f172a;margin:0 0 6px;">You left items in your cart 🛍️</h2>
    <p style="color:#475569;font-size:14px;margin:0 0 20px;">
      Your cart at <strong>${company.companyName}</strong> is still waiting for you.
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:16px;">
      ${rows}
      <tr><td style="padding:10px 12px;font-weight:700;font-size:15px;">Total</td>
      <td style="padding:10px 12px;font-weight:700;font-size:15px;text-align:right;">${naira(cart.total)}</td></tr>
    </table>
    <p style="margin:20px 0 0;"><a href="${recoverUrl}" style="background:#6366f1;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Complete your order</a></p>
  `);
  return {
    to: cart.customer.email,
    subject: `You left items in your cart at ${company.companyName}`,
    html,
    text: `Your cart at ${company.companyName} is waiting — total ${naira(cart.total)}. Complete your order: ${recoverUrl}`,
  };
}

async function checkAbandonedCarts() {
  try {
    const now = Date.now();
    const carts = await AbandonedCart.find({
      recovered: false,
      remindersSent: { $lt: 2 },
      updatedAt: { $lte: new Date(now - HOUR) },
    });
    if (!carts.length) return;

    let sent = 0;
    for (const cart of carts) {
      const dueForSecond = cart.remindersSent === 1 && now - new Date(cart.updatedAt).getTime() >= 24 * HOUR;
      const dueForFirst = cart.remindersSent === 0;
      if (!dueForFirst && !dueForSecond) continue;
      if (!cart.customer?.email || !cart.items?.length) continue;

      // eslint-disable-next-line no-await-in-loop
      const company = await Company.findById(cart.companyId).select('companyName storeSlug storeEnabled');
      if (!company?.storeEnabled) continue;

      const recoverUrl = `${clientUrl()}/store/${company.storeSlug}?recover=${encodeURIComponent(cart.sessionId)}`;
      // eslint-disable-next-line no-await-in-loop
      await emailService.send(reminderEmail(company, cart, recoverUrl)).catch((e) => logger.warn(`Abandoned cart reminder email failed for ${cart._id}: ${e.message}`));

      cart.remindersSent += 1;
      cart.lastReminderAt = new Date();
      // eslint-disable-next-line no-await-in-loop
      await cart.save();
      sent += 1;
    }

    if (sent) logger.warn(`Abandoned cart reminders: sent ${sent} of ${carts.length} eligible cart(s)`);
  } catch (err) {
    logger.error(`checkAbandonedCarts failed: ${err.message}`);
  }
}

module.exports = { checkAbandonedCarts };
