'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const TERMII_API_KEY = process.env.TERMII_API_KEY;
// Termii is rejecting every sender ID tried on this workspace so far
// ('generic', 'terminus') — 'talert' is a Termii-provided shared/pre-approved
// ID that doesn't need per-workspace registration, used as the default here
// so SMS keeps working out of the box. Still overridable via env once a real
// registered sender ID (e.g. "BizlyAI") is approved for this account,
// without needing another code change.
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || 'talert';
// 'dnd' (Do-Not-Disturb bypass) requires a use-case Termii approves per
// workspace; 'generic' doesn't, so it's the safer default while sender-ID/
// channel approval is still being sorted out for this account.
const TERMII_CHANNEL = process.env.TERMII_CHANNEL || 'generic';
const TERMII_BASE = 'https://api.ng.termii.com/api';

function formatNigerianPhone(phone) {
  if (!phone) return null;
  const cleaned = String(phone).replace(/\D/g, '');

  if (cleaned.startsWith('234') && cleaned.length === 13) return cleaned;
  if (cleaned.startsWith('0') && cleaned.length === 11) return '234' + cleaned.slice(1);
  if (cleaned.length === 10) return '234' + cleaned;

  return null;
}

async function sendSMS({ to, message }) {
  if (!TERMII_API_KEY) {
    logger.warn('TERMII_API_KEY not set — SMS skipped');
    return null;
  }

  const phone = formatNigerianPhone(to);
  if (!phone) {
    logger.warn(`Invalid phone number for SMS: ${to}`);
    return null;
  }

  try {
    const response = await axios.post(`${TERMII_BASE}/sms/send`, {
      to: phone,
      from: TERMII_SENDER_ID,
      sms: message,
      type: 'plain',
      channel: TERMII_CHANNEL,
      api_key: TERMII_API_KEY,
    });

    // console.log (not logger.info) so this is visible on Render regardless
    // of log level — same reasoning as the storefront-order webhook and
    // emailService fixes. Logging the full response, not just message_id,
    // since Termii can 200 back a rejection reason in the body rather than
    // an HTTP error status.
    console.log(`✅ SMS sent to ${phone}:`, response.data);
    return response.data;
  } catch (err) {
    const errorMsg = err.response?.data?.message || err.message;
    console.error(`❌ SMS failed to ${phone}:`, errorMsg);
    console.error('Full SMS error:', JSON.stringify(err.response?.data));
    return null; // Never throw — SMS failure shouldn't break the calling flow
  }
}

// ── Templates ────────────────────────────────────────────────────────────
async function sendInvoiceSMS(phone, customerName, invoiceNumber, amount, companyName) {
  return sendSMS({
    to: phone,
    message: `Hi ${customerName}, you have an invoice ${invoiceNumber} of NGN ${Number(amount).toLocaleString()} from ${companyName}. Please make payment. - BizlyAI`,
  });
}

async function sendPaymentReminderSMS(phone, customerName, invoiceNumber, amount, daysOverdue) {
  return sendSMS({
    to: phone,
    message: `Hi ${customerName}, your invoice ${invoiceNumber} of NGN ${Number(amount).toLocaleString()} is ${daysOverdue} day(s) overdue. Please pay now to avoid service disruption. - BizlyAI`,
  });
}

async function sendOrderConfirmationSMS(phone, customerName, orderNumber, amount) {
  return sendSMS({
    to: phone,
    message: `Hi ${customerName}, your order ${orderNumber} of NGN ${Number(amount).toLocaleString()} has been confirmed. We will notify you when it ships. - BizlyAI`,
  });
}

async function sendOrderDeliveredSMS(phone, customerName, orderNumber) {
  return sendSMS({
    to: phone,
    message: `Hi ${customerName}, your order ${orderNumber} has been delivered. Thank you for shopping with us! - BizlyAI`,
  });
}

async function sendAppointmentReminderSMS(phone, customerName, title, date, time) {
  return sendSMS({
    to: phone,
    message: `Hi ${customerName}, reminder: you have an appointment "${title}" on ${date} at ${time}. Reply CANCEL to cancel. - BizlyAI`,
  });
}

async function sendStoreOrderSMS(phone, ownerName, customerName, amount, storeName) {
  return sendSMS({
    to: phone,
    message: `New order alert! ${customerName} just placed an order of NGN ${Number(amount).toLocaleString()} on your ${storeName} store. Login to BizlyAI to process. - BizlyAI`,
  });
}

async function sendWelcomeSMS(phone, name, companyName) {
  return sendSMS({
    to: phone,
    message: `Welcome to BizlyAI, ${name}! Your ${companyName} workspace is ready. Login at bislyai.com to get started. - BizlyAI`,
  });
}

async function sendPayslipSMS(phone, name, month, year, netSalary) {
  return sendSMS({
    to: phone,
    message: `Hi ${name}, your payslip for ${month}/${year} is ready. Net salary: NGN ${Number(netSalary).toLocaleString()}. Login to BizlyAI to view details. - BizlyAI`,
  });
}

async function sendLowStockSMS(phone, ownerName, productName, quantity) {
  return sendSMS({
    to: phone,
    message: `Low stock alert! ${productName} has only ${quantity} unit(s) left. Login to BizlyAI to restock. - BizlyAI`,
  });
}

module.exports = {
  sendSMS,
  formatNigerianPhone,
  sendInvoiceSMS,
  sendPaymentReminderSMS,
  sendOrderConfirmationSMS,
  sendOrderDeliveredSMS,
  sendAppointmentReminderSMS,
  sendStoreOrderSMS,
  sendWelcomeSMS,
  sendPayslipSMS,
  sendLowStockSMS,
};
