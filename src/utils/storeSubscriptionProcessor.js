'use strict';

// Daily job (see server.js, runs at 6am — checked hourly like the other
// time-of-day jobs in this file, e.g. recurringInvoices/loyaltyPoints, so it
// fires at a predictable hour instead of drifting to server-boot time)
// that turns every due StoreSubscription into a real order: charges the
// saved card for paystack subscriptions, or creates an unpaid order for
// pay_on_delivery ones, then advances nextDeliveryDate.
const StoreSubscription = require('../models/StoreSubscription');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');
const { calculateNextDate, createSubscriptionOrder } = require('../controllers/storeSubscriptionController');
const { notifyCustomer } = require('../controllers/subscriptionPlanController');

const MAX_FAILED_ATTEMPTS = 3;
const naira = (n) => `₦${Number(n || 0).toLocaleString()}`;

async function processStoreSubscriptions() {
  const due = await StoreSubscription.find({ status: 'active', nextDeliveryDate: { $lte: new Date() } });
  if (!due.length) return;
  logger.warn(`Processing ${due.length} store subscription(s)`);

  let created = 0;
  let failed = 0;
  for (const sub of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { order } = await createSubscriptionOrder(sub);

      sub.lastDeliveryDate = new Date();
      sub.nextDeliveryDate = calculateNextDate(sub.interval);
      sub.totalDeliveries += 1;
      sub.failedAttempts = 0;
      sub.deliveryHistory.push({ orderId: order._id, deliveryDate: new Date(), status: 'created', amount: sub.total });

      if (sub.maxDeliveries && sub.totalDeliveries >= sub.maxDeliveries) {
        sub.status = 'expired';
        sub.endDate = new Date();
      }

      // eslint-disable-next-line no-await-in-loop
      await sub.save();
      created += 1;
      logger.warn(`✅ Subscription order created for ${sub.customerEmail} (${sub.name})`);
    } catch (err) {
      failed += 1;
      logger.error(`❌ Subscription failed for ${sub._id}: ${err.message}`);
      // eslint-disable-next-line no-await-in-loop
      await handleFailedDelivery(sub, err).catch((e) => logger.error(`handleFailedDelivery failed for ${sub._id}: ${e.message}`));
    }
  }
  logger.warn(`Store subscriptions processed: ${created} created, ${failed} failed.`);
}

// Pay-on-delivery orders never "fail" here except on a genuine server error
// (no payment is ever attempted for them) — leave nextDeliveryDate alone so
// it's simply retried on tomorrow's run rather than applying the card-
// specific retry/cancel-after-3 rules, which only make sense for a declined
// Paystack charge_authorization.
async function handleFailedDelivery(sub, err) {
  if (sub.paymentMethod !== 'paystack') {
    logger.error(`Non-payment delivery error for subscription ${sub._id}, will retry next run: ${err.message}`);
    return;
  }

  sub.failedAttempts = (sub.failedAttempts || 0) + 1;
  sub.lastFailedAt = new Date();
  sub.deliveryHistory.push({ deliveryDate: new Date(), status: 'failed', amount: sub.total });

  if (sub.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    sub.status = 'cancelled';
    sub.cancelledAt = new Date();
    sub.cancellationReason = `Payment failed ${sub.failedAttempts} times in a row`;
    await sub.save();

    const Company = require('../models/Company');
    const company = await Company.findById(sub.companyId).select('companyName logo owner');
    if (company) {
      notifyCustomer(company, sub, 'cancelled', { by: 'store' }).catch(() => {});
      const User = require('../models/User');
      User.findById(company.owner).select('email').then((owner) => {
        if (!owner?.email) return;
        emailService.send({
          to: owner.email,
          subject: `Subscription auto-cancelled — ${sub.name}`,
          html: emailService.baseTemplate('Subscription cancelled', `
            <h2 style="color:#0f172a;margin:0 0 6px;">A subscription was auto-cancelled</h2>
            <p style="color:#475569;font-size:14px;">${sub.customerName || sub.customerEmail}'s <strong>${sub.name}</strong> subscription (${naira(sub.total)}/${sub.interval}) was cancelled after 3 failed payment attempts.</p>
          `, { name: company.companyName, logo: company.logo }),
        }).catch(() => {});
      }).catch(() => {});
    }
    return;
  }

  // Retry tomorrow — stay active in the meantime.
  sub.nextDeliveryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await sub.save();

  emailService.send({
    to: sub.customerEmail,
    subject: `We couldn't process your ${sub.name} payment`,
    html: emailService.baseTemplate('Payment failed', `
      <h2 style="color:#0f172a;margin:0 0 6px;">Your payment didn't go through</h2>
      <p style="color:#475569;font-size:14px;">We tried to charge your card ${naira(sub.total)} for your <strong>${sub.name}</strong> subscription and it failed (${err.message || 'card declined'}).</p>
      <p style="color:#475569;font-size:14px;">We'll try again in 24 hours. After ${MAX_FAILED_ATTEMPTS} failed attempts your subscription will be cancelled — update your card details with the store if this keeps happening.</p>
    `),
  }).catch((e) => logger.warn(`Subscription payment-failed email failed: ${e.message}`));
}

module.exports = { processStoreSubscriptions };
