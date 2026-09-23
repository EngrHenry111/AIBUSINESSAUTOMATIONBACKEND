'use strict';

const mongoose = require('mongoose');

const approvalStepSchema = new mongoose.Schema({
  approverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  approverName: { type: String, required: true },
  approverRole: { type: String, required: true }, // e.g. "Department Head", "Finance Officer", "MD/Director"
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  comment: { type: String, maxlength: 2000 },
  actionedAt: Date,
  order: { type: Number, required: true }, // 1, 2, 3 — sequential, cannot be skipped
}, { _id: false });

const procurementItemSchema = new mongoose.Schema({
  description: { type: String, required: true, trim: true },
  quantity: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true, default: 'pieces' },
  estimatedUnitPrice: { type: Number, required: true, min: 0 },
  estimatedTotal: { type: Number, required: true, min: 0 },
  actualUnitPrice: Number,
  actualTotal: Number,
  category: { type: String, trim: true },
}, { _id: false });

const vendorQuoteSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, trim: true, lowercase: true },
  phone: { type: String, trim: true },
  address: { type: String, trim: true },
  rcNumber: { type: String, trim: true },
  quotedPrice: { type: Number, required: true, min: 0 },
  selected: { type: Boolean, default: false },
  quotationDocument: String,
  addedAt: { type: Date, default: Date.now },
});

const auditEntrySchema = new mongoose.Schema({
  action: { type: String, required: true },
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  performedByName: String,
  timestamp: { type: Date, default: Date.now },
  comment: String,
  ipAddress: String,
}, { _id: false });

const procurementSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  referenceNumber: { type: String, required: true, trim: true }, // PR/2026/001
  title: { type: String, required: true, trim: true, maxlength: 300 },
  type: {
    type: String,
    enum: ['purchase_requisition', 'request_for_quotation', 'purchase_order', 'contract_award', 'goods_receipt', 'payment_voucher'],
    default: 'purchase_requisition',
  },
  status: {
    type: String,
    enum: ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled', 'completed'],
    default: 'draft',
  },
  priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
  department: { type: String, trim: true },
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  approvalChain: { type: [approvalStepSchema], default: [] },
  currentApprovalLevel: { type: Number, default: 0 }, // 0 = no approvals yet; N = step N (1-indexed) is next

  items: { type: [procurementItemSchema], default: [] },
  estimatedTotal: { type: Number, default: 0 },
  actualTotal: Number,
  currency: { type: String, default: 'NGN' },

  budget: {
    code: String,
    description: String,
    available: Number,
    allocated: Number,
  },

  vendors: { type: [vendorQuoteSchema], default: [] },
  selectedVendor: {
    name: String,
    email: String,
    amount: Number,
  },

  documents: [{
    name: String,
    type: String,
    url: String,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  }],

  deliveryDate: Date,
  deliveryLocation: { type: String, trim: true },
  receivedBy: String,
  receivedAt: Date,
  notes: { type: String, maxlength: 3000 },

  auditTrail: { type: [auditEntrySchema], default: [] },
}, { timestamps: true });

procurementSchema.index({ companyId: 1, status: 1 });
procurementSchema.index({ companyId: 1, type: 1 });
procurementSchema.index({ companyId: 1, department: 1 });
procurementSchema.index({ companyId: 1, referenceNumber: 1 }, { unique: true });
procurementSchema.index({ companyId: 1, createdAt: -1 });

module.exports = mongoose.model('Procurement', procurementSchema);
