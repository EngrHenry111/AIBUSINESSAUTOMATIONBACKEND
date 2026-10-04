'use strict';

// Real PDF of an invoice, for email attachments. Pure JS (pdfkit) on
// purpose: headless Chrome can't launch on Render (see whatsappService),
// so an HTML-to-PDF approach would fail in production.
const PDFDocument = require('pdfkit');

const BRAND = '#6366f1';
const INK = '#1e293b';
const MUTED = '#64748b';
const LINE = '#e2e8f0';

// pdfkit's built-in Helvetica has no ₦ glyph, so amounts use the ISO code.
const amount = (n, cur) => `${cur || 'NGN'} ${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
// Strip characters outside WinAnsi that Helvetica can't render.
const clean = (s) => String(s ?? '').replace(/₦/g, 'NGN ').replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”•…€]/g, '');

function renderInvoicePdf(invoice, company) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${invoice.invoiceNumber}`, Author: company?.companyName || 'BizlyAI' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const cur = invoice.currency || 'NGN';
    const profile = company?.profile || {};
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const width = right - left;

    // Header
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(20).text(clean(company?.companyName || 'Invoice'), left, 50, { width: width / 2 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(9);
    [profile.tagline, profile.address, profile.email, profile.phone, profile.rcNumber && `RC: ${profile.rcNumber}`, profile.tin && `TIN: ${profile.tin}`]
      .filter(Boolean).forEach((l) => doc.text(clean(l), { width: width / 2 }));
    const headerBottom = doc.y;

    doc.fillColor(INK).font('Helvetica-Bold').fontSize(22).text('INVOICE', left + width / 2, 50, { width: width / 2, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor(MUTED);
    [
      ['Invoice no.', invoice.invoiceNumber],
      invoice.orderNumber && ['Order', invoice.orderNumber],
      invoice.matterNumber && ['Matter', invoice.matterNumber],
      ['Issued', day(invoice.issuedAt)],
      ['Due', day(invoice.dueAt)],
      ['Status', String(invoice.status || '').toUpperCase()],
    ].filter(Boolean).forEach(([k, v]) => doc.text(`${k}: ${clean(v)}`, left + width / 2, doc.y, { width: width / 2, align: 'right' }));

    // Bill to
    let y = Math.max(headerBottom, doc.y) + 25;
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('BILL TO', left, y);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(11).text(clean(invoice.customer?.name), left, doc.y + 2);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    [invoice.customer?.email, invoice.customer?.phone, invoice.customer?.address].filter(Boolean).forEach((l) => doc.text(clean(l)));

    // Items table
    y = doc.y + 20;
    const cols = [
      { label: 'Description', x: left, w: width * 0.5, align: 'left' },
      { label: 'Qty', x: left + width * 0.5, w: width * 0.1, align: 'right' },
      { label: 'Unit price', x: left + width * 0.6, w: width * 0.2, align: 'right' },
      { label: 'Amount', x: left + width * 0.8, w: width * 0.2, align: 'right' },
    ];
    doc.rect(left, y, width, 20).fill('#f1f5f9');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9);
    cols.forEach((c) => doc.text(c.label.toUpperCase(), c.x + 4, y + 6, { width: c.w - 8, align: c.align }));
    y += 24;

    doc.font('Helvetica').fontSize(10).fillColor(INK);
    for (const it of invoice.items || []) {
      const desc = clean(it.description);
      const h = Math.max(doc.heightOfString(desc, { width: cols[0].w - 8 }), 12) + 8;
      if (y + h > doc.page.height - doc.page.margins.bottom - 120) { doc.addPage(); y = doc.page.margins.top; }
      doc.text(desc, cols[0].x + 4, y, { width: cols[0].w - 8 });
      doc.text(String(it.quantity ?? 1), cols[1].x + 4, y, { width: cols[1].w - 8, align: 'right' });
      doc.text(amount(it.unitPrice, cur), cols[2].x + 4, y, { width: cols[2].w - 8, align: 'right' });
      doc.text(amount(it.total, cur), cols[3].x + 4, y, { width: cols[3].w - 8, align: 'right' });
      y += h;
      doc.moveTo(left, y - 3).lineTo(right, y - 3).strokeColor(LINE).lineWidth(0.5).stroke();
    }

    // Totals
    y += 8;
    const tx = left + width * 0.55;
    const tw = width * 0.45;
    const totalRow = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor(bold ? INK : MUTED);
      doc.text(label, tx, y, { width: tw / 2 });
      doc.fillColor(INK).text(value, tx + tw / 2, y, { width: tw / 2, align: 'right' });
      y += bold ? 20 : 16;
    };
    totalRow('Subtotal', amount(invoice.subtotal, cur));
    if (invoice.tax) totalRow('Tax', amount(invoice.tax, cur));
    if (invoice.discount) totalRow('Discount', `-${amount(invoice.discount, cur)}`);
    doc.moveTo(tx, y).lineTo(right, y).strokeColor(INK).lineWidth(1).stroke();
    y += 6;
    totalRow('Total', amount(invoice.total, cur), true);

    // Notes + payment details
    y += 10;
    if (invoice.notes) {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('NOTES', left, y);
      doc.fillColor(INK).font('Helvetica').fontSize(10).text(clean(invoice.notes), left, doc.y + 2, { width });
      y = doc.y + 14;
    }
    const ps = company?.paymentSettings;
    if (ps?.isPaymentSetup && invoice.status !== 'paid') {
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9).text('PAYMENT DETAILS', left, y);
      doc.fillColor(INK).font('Helvetica').fontSize(10);
      [['Bank', ps.bankName], ['Account name', ps.accountName], ['Account number', ps.accountNumber], ['Reference', invoice.invoiceNumber]]
        .filter(([, v]) => v).forEach(([k, v]) => doc.text(`${k}: ${clean(v)}`, left, doc.y + 2));
    }

    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Thank you for your business${company?.companyName ? ` - ${clean(company.companyName)}` : ''}. Generated by BizlyAI.`,
        left, doc.page.height - doc.page.margins.bottom - 12, { width, align: 'center', lineBreak: false });
    doc.end();
  });
}

module.exports = { renderInvoicePdf };
