'use strict';

/**
 * Finds the Contact behind a conversation (or creates one) so the same
 * person is recognised on every channel. Never throws: a contact problem
 * must not stop a customer getting an answer.
 */
const Contact = require('../../models/Contact');
const Customer = require('../../models/Customer');
const Lead = require('../../models/Lead');
const logger = require('../../utils/logger');

const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

const cleanEmail = (e) => (EMAIL_RE.test(String(e || '').trim()) ? String(e).trim().toLowerCase() : undefined);
const isPlaceholderName = (name, c) => !name || name === c.phone || name === c.email || /^\+?\d[\d\s-]*$/.test(name);

// The ways a phone number is usually typed in Nigeria, for matching the
// Customer records staff entered by hand.
function phoneVariants(phone, key) {
  if (!key) return [];
  return [...new Set([String(phone || '').trim(), key, `0${key}`, `234${key}`, `+234${key}`].filter(Boolean))];
}

async function findCustomer(companyId, { email, phone, phoneKey }) {
  const or = [];
  if (email) or.push({ email });
  const variants = phoneVariants(phone, phoneKey);
  if (variants.length) or.push({ phone: { $in: variants } });
  if (!or.length) return null;
  return Customer.findOne({ companyId, $or: or }).select('_id').lean();
}

/**
 * @param {Document} convo       a Conversation (saved, with companyId/channel/externalId)
 * @param {Object}   who         { name, email, phone } as known so far
 * @param {Object}   [opts]
 * @param {boolean}  [opts.requireIdentity] only create a new contact when an
 *                   email or phone is known (anonymous website visitors)
 * @returns {Promise<Document|null>} the contact, also linked on convo.contactId
 */
async function attachContact(convo, { name, email, phone } = {}, { requireIdentity = false } = {}) {
  try {
    const { companyId, channel, externalId } = convo;
    const mail = cleanEmail(email);
    const tel = String(phone || '').trim() || undefined;
    const phoneKey = Contact.phoneKeyOf(tel);
    const handle = { channel, externalId: String(externalId) };

    let contact = convo.contactId ? await Contact.findOne({ _id: convo.contactId, companyId }) : null;
    if (!contact) contact = await Contact.findOne({ companyId, handles: { $elemMatch: handle } });
    if (!contact && phoneKey) contact = await Contact.findOne({ companyId, phoneKey });
    if (!contact && mail) contact = await Contact.findOne({ companyId, email: mail });

    let created = false;
    if (!contact) {
      if (requireIdentity && !mail && !phoneKey) return null;
      contact = new Contact({ companyId, name: name || mail || tel, email: mail, phone: tel, handles: [handle] });
      created = true;
    }

    const cleanName = String(name || '').trim().slice(0, 200);
    if (cleanName && !isPlaceholderName(cleanName, contact) && isPlaceholderName(contact.name, contact)) contact.name = cleanName;
    if (!contact.name) contact.name = mail || tel;
    const gainedId = (mail && !contact.email) || (tel && !contact.phone);
    if (mail && !contact.email) contact.email = mail;
    if (tel && !contact.phone) contact.phone = tel;
    if (!contact.handles.some((h) => h.channel === handle.channel && h.externalId === handle.externalId)) {
      contact.handles.push(handle);
    }
    contact.lastSeenAt = new Date();
    contact.lastChannel = channel;

    if (created || gainedId) {
      const key = contact.phoneKey || Contact.phoneKeyOf(contact.phone);
      if (!contact.customerId) {
        const customer = await findCustomer(companyId, { email: contact.email, phone: contact.phone, phoneKey: key });
        if (customer) contact.customerId = customer._id;
      }
      if (!contact.leadId) {
        const or = [];
        if (contact.email) or.push({ email: contact.email });
        if (key) or.push({ phoneKey: key });
        const lead = or.length ? await Lead.findOne({ companyId, $or: or }).sort({ createdAt: -1 }).select('_id').lean() : null;
        if (lead) contact.leadId = lead._id;
      }
    }
    await contact.save();

    if (String(convo.contactId || '') !== String(contact._id)) {
      convo.contactId = contact._id;
      await convo.constructor.updateOne({ _id: convo._id }, { contactId: contact._id });
    }
    return contact;
  } catch (err) {
    logger.warn(`Inbox contact link failed: ${err.message}`);
    return null;
  }
}

/** Remember the lead a contact belongs to (set by lead capture). */
async function linkLead(contact, leadId) {
  if (!contact || !leadId || String(contact.leadId || '') === String(leadId)) return;
  try { await Contact.updateOne({ _id: contact._id }, { leadId }); } catch { /* best effort */ }
}

module.exports = { attachContact, linkLead, phoneVariants };
