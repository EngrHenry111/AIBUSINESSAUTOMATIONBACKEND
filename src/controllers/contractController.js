'use strict';

const Contract = require('../models/Contract');
const Company = require('../models/Company');
const { runAgent } = require('../services/groqService');
const { cleanAIText } = require('../utils/cleanAIText');
const emailService = require('../services/emailService');
const { AppError } = require('../middleware/errorMiddleware');
const logger = require('../utils/logger');

const COMPANY_BRANDING_FIELDS = 'companyName logo website profile';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (d) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—');
const money = (n, cur) => `${cur || 'NGN'} ${Number(n || 0).toLocaleString()}`;

const TYPE_LABELS = {
  service_agreement: 'Service Agreement', employment: 'Employment Contract', nda: 'Non-Disclosure Agreement',
  vendor: 'Vendor Agreement', freelance: 'Freelance Contract', partnership: 'Partnership Agreement',
  lease: 'Lease Agreement', sale_of_goods: 'Sale of Goods Agreement', consulting: 'Consulting Agreement',
  retainer: 'Retainer Agreement', custom: 'Custom Contract',
};

function buildContractPrompt({ type, parties, terms, customClauses }) {
  const p1 = parties?.party1 || {};
  const p2 = parties?.party2 || {};
  const t = terms || {};
  const clauses = (customClauses || []).filter(Boolean);

  return `Generate a professional legal contract for Nigerian law with these details:

Contract Type: ${TYPE_LABELS[type] || type}
Company (Party 1): ${p1.name || '—'}, ${p1.role || 'Party 1'}
Address: ${p1.address || '—'}
Client (Party 2): ${p2.name || '—'}, ${p2.role || 'Party 2'}
Address: ${p2.address || '—'}

Terms:
- Start Date: ${t.startDate ? day(t.startDate) : 'Not specified'}
- End Date: ${t.endDate ? day(t.endDate) : 'Not specified'}
- Contract Value: ${t.value ? money(t.value, t.currency) : 'Not specified'}
- Payment Terms: ${t.paymentTerms || 'Not specified'}
- Deliverables: ${t.deliverables || 'Not specified'}
- Governing Law: ${t.governingLaw || 'Federal Republic of Nigeria'}

${clauses.length ? `Custom Clauses:\n${clauses.map((c, i) => `${i + 1}. ${c}`).join('\n')}` : 'Custom Clauses: None'}

Generate a complete, professional contract with these sections:
1. PARTIES
2. RECITALS
3. SCOPE OF WORK/SERVICES
4. PAYMENT TERMS
5. DURATION AND TERMINATION
6. CONFIDENTIALITY
7. INTELLECTUAL PROPERTY
8. LIABILITY AND INDEMNIFICATION
9. DISPUTE RESOLUTION (use Nigerian courts)
10. GENERAL PROVISIONS
11. SIGNATURES

Use proper legal language suitable for Nigerian business law and CAMA 2020.
Format with clear headings and numbered clauses.
Do not use markdown — use plain text only.`;
}

// Plain-text contract body -> safe HTML for email/PDF. ALL-CAPS lines (the
// numbered section headings the AI is instructed to produce) are promoted to
// headings; everything else is escaped and wrapped in paragraphs.
function contractContentToHtml(content) {
  const HEADING_RE = /^[0-9]{0,2}\.?\s*[A-Z][A-Z0-9 .,'&()/-]{3,80}$/;
  return String(content || '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.map((line) => {
        if (HEADING_RE.test(line)) {
          return `<h3 style="font-size:15px;font-weight:800;color:#0f172a;margin:22px 0 8px;">${esc(line)}</h3>`;
        }
        return `<p style="font-size:13.5px;line-height:1.7;color:#334155;margin:0 0 10px;">${esc(line)}</p>`;
      }).join('');
    })
    .join('');
}

function signatureBlockHtml(contract) {
  const p1 = contract.parties?.party1 || {};
  const p2 = contract.parties?.party2 || {};
  const sigBox = (label, party) => `
    <td style="width:50%;padding:0 12px;vertical-align:top;">
      <p style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;margin:0 0 40px;">${esc(label)}</p>
      <div style="border-top:1px solid #334155;padding-top:6px;">
        <p style="font-size:13px;font-weight:700;color:#0f172a;margin:0;">${esc(party.name || '—')}</p>
        <p style="font-size:12px;color:#64748b;margin:2px 0 0;">${esc(party.role || '—')}</p>
        <p style="font-size:11px;color:#94a3b8;margin:10px 0 0;">Date: _______________</p>
      </div>
    </td>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:40px;"><tr>${sigBox('Party 1', p1)}${sigBox('Party 2', p2)}</tr></table>`;
}

function contractHtmlDocument(contract, company) {
  const profile = company?.profile || {};
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<title>${esc(contract.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1e293b; max-width: 800px; margin: 0 auto; padding: 48px 32px; }
  .letterhead { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1e293b; padding-bottom: 16px; margin-bottom: 24px; }
  .letterhead img { height: 48px; }
  .letterhead h2 { margin: 0; font-size: 18px; }
  .letterhead p { margin: 2px 0 0; font-size: 12px; color: #64748b; font-family: Arial, sans-serif; }
  h1 { font-size: 20px; text-align: center; margin: 0 0 4px; }
  .subtitle { text-align: center; font-size: 12px; color: #64748b; margin: 0 0 28px; font-family: Arial, sans-serif; }
  .disclaimer { font-family: Arial, sans-serif; font-size: 10.5px; color: #94a3b8; border: 1px dashed #cbd5e1; padding: 10px 12px; border-radius: 6px; margin-bottom: 24px; }
  .print-hint {
    position: fixed; top: 20px; right: 20px; font-family: Arial, sans-serif; font-size: 12px; font-weight: 700;
    background: #1e293b; color: #fff; border-radius: 8px; padding: 9px 16px;
  }
  @media print { body { padding: 0; } .no-print { display: none !important; } }
</style>
</head>
<body>
  <!-- This response is served with a strict script-src 'none' CSP (see
       app.js) for the same reason the invoice/meeting-minutes PDF exports
       are — it embeds contract text a user has edited, so no inline script
       (including a window.print() button) can run here. Every browser's
       own Ctrl+P / File > Print already does the job. -->
  <div class="print-hint no-print">Press Ctrl+P (⌘P on Mac) to print or save as PDF</div>
  <div class="letterhead">
    ${company?.logo ? `<img src="${esc(company.logo)}" alt="${esc(company.companyName)}"/>` : ''}
    <div>
      <h2>${esc(company?.companyName || 'BizlyAI')}</h2>
      ${[profile.address, profile.email, profile.phone].filter(Boolean).map(esc).join(' · ') ? `<p>${[profile.address, profile.email, profile.phone].filter(Boolean).map(esc).join(' · ')}</p>` : ''}
    </div>
  </div>

  <h1>${esc(contract.title)}</h1>
  <p class="subtitle">${esc(TYPE_LABELS[contract.type] || contract.type)} · Drafted ${day(contract.createdAt)}</p>

  <div class="disclaimer">This document was drafted with AI assistance as a first draft. Have it reviewed by a qualified lawyer before signing.</div>

  ${contractContentToHtml(contract.content)}

  ${signatureBlockHtml(contract)}
</body>
</html>`;
}

// ── POST /contracts/generate ──────────────────────────────────────────────
exports.generateContract = async (req, res, next) => {
  try {
    const { title, type, parties, terms, customClauses, linkedInvoiceId, linkedLeadId } = req.body;
    if (!type) return next(new AppError('Contract type is required.', 400));
    if (!parties?.party1?.name || !parties?.party2?.name) {
      return next(new AppError('Both parties need at least a name.', 400));
    }

    const prompt = buildContractPrompt({ type, parties, terms, customClauses });
    const content = await runAgent('contract_agent', prompt, { useSmartModel: true, maxTokens: 3500 });

    const contract = await Contract.create({
      companyId: req.companyId,
      title: title || `${TYPE_LABELS[type] || type} — ${parties.party2.name}`,
      type,
      parties,
      terms,
      customClauses: (customClauses || []).filter(Boolean),
      content,
      aiGenerated: true,
      linkedInvoiceId: linkedInvoiceId || undefined,
      linkedLeadId: linkedLeadId || undefined,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, data: contract });
  } catch (err) { next(err); }
};

// ── GET /contracts ─────────────────────────────────────────────────────────
exports.getContracts = async (req, res, next) => {
  try {
    const { status, type, search, sort = '-createdAt', page = 1, limit = 100 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (type) filter.type = type;
    if (search) filter.$or = [
      { title: { $regex: search, $options: 'i' } },
      { 'parties.party1.name': { $regex: search, $options: 'i' } },
      { 'parties.party2.name': { $regex: search, $options: 'i' } },
    ];

    const sortSpec = sort.startsWith('-') ? { [sort.slice(1)]: -1 } : { [sort]: 1 };
    const [contracts, total] = await Promise.all([
      Contract.find(filter).sort(sortSpec).skip((page - 1) * limit).limit(Number(limit)),
      Contract.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, data: contracts, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

// ── GET /contracts/:id ───────────────────────────────────────────────────
exports.getContract = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));
    res.status(200).json({ success: true, data: contract });
  } catch (err) { next(err); }
};

// ── PUT /contracts/:id ────────────────────────────────────────────────────
// Only a draft can be freely edited — once sent, the copy the other party
// received must stay the copy they can sign; status moves forward only via
// sendContract() and markSigned() below, never through this generic update.
const EDITABLE_FIELDS = ['title', 'content', 'parties', 'terms', 'customClauses', 'expiresAt'];
exports.updateContract = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));
    if (contract.status !== 'draft') {
      return next(new AppError('Only draft contracts can be edited.', 400));
    }

    EDITABLE_FIELDS.forEach((f) => { if (req.body[f] !== undefined) contract[f] = req.body[f]; });
    if (req.body.content !== undefined) contract.aiGenerated = false; // manual edits mean it's no longer purely AI output

    await contract.save();
    res.status(200).json({ success: true, data: contract });
  } catch (err) { next(err); }
};

// ── DELETE /contracts/:id ─────────────────────────────────────────────────
exports.deleteContract = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));
    if (contract.status !== 'draft') {
      return next(new AppError('Only draft contracts can be deleted. Cancel a sent/signed contract instead.', 400));
    }
    await contract.deleteOne();
    res.status(200).json({ success: true, message: 'Contract deleted.' });
  } catch (err) { next(err); }
};

// ── POST /contracts/:id/send ──────────────────────────────────────────────
exports.sendContract = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));
    if (!contract.parties?.party2?.email) return next(new AppError('Party 2 has no email address on file.', 400));

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const html = emailService.baseTemplate(
      `Contract for Review: ${contract.title}`,
      contractContentToHtml(contract.content) + signatureBlockHtml(contract),
      { name: company?.companyName, logo: company?.logo, tagline: company?.profile?.tagline },
    );

    await emailService.send({
      to: contract.parties.party2.email,
      subject: `Contract for Review: ${contract.title}`,
      html,
    });

    contract.status = 'sent';
    contract.sentAt = new Date();
    await contract.save();

    res.status(200).json({ success: true, data: contract });
  } catch (err) {
    logger.error(`Contract send failed: ${err.message}`);
    next(err);
  }
};

// ── GET /contracts/:id/pdf ─────────────────────────────────────────────────
exports.generatePDF = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));

    const company = await Company.findById(req.companyId).select(COMPANY_BRANDING_FIELDS);
    const html = contractHtmlDocument(contract, company);

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="contract-${contract._id}.html"`);
    res.send(html);
  } catch (err) { next(err); }
};

// ── POST /contracts/:id/duplicate ─────────────────────────────────────────
exports.duplicateContract = async (req, res, next) => {
  try {
    const original = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!original) return next(new AppError('Contract not found.', 404));

    const copy = await Contract.create({
      companyId: req.companyId,
      title: `${original.title} (Copy)`,
      type: original.type,
      status: 'draft',
      parties: original.parties,
      terms: original.terms,
      content: original.content,
      aiGenerated: original.aiGenerated,
      customClauses: original.customClauses,
      createdBy: req.user._id,
    });

    res.status(201).json({ success: true, data: copy });
  } catch (err) { next(err); }
};

// ── PATCH /contracts/:id/sign ────────────────────────────────────────────
exports.markSigned = async (req, res, next) => {
  try {
    const contract = await Contract.findOne({ _id: req.params.id, companyId: req.companyId });
    if (!contract) return next(new AppError('Contract not found.', 404));
    if (contract.status === 'signed') return res.status(200).json({ success: true, data: contract });

    contract.status = 'signed';
    contract.signedAt = new Date();
    await contract.save();
    res.status(200).json({ success: true, data: contract });
  } catch (err) { next(err); }
};
