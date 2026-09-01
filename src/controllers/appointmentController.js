'use strict';

const Appointment = require('../models/Appointment');
const { runAgent } = require('../services/groqService');
const { AppError } = require('../middleware/errorMiddleware');

exports.getAppointments = async (req, res, next) => {
  try {
    const { status, from, to, page = 1, limit = 20 } = req.query;
    const filter = { companyId: req.companyId };
    if (status) filter.status = status;
    if (from || to) filter.scheduledAt = {};
    if (from) filter.scheduledAt.$gte = new Date(from);
    if (to) filter.scheduledAt.$lte = new Date(to);

    const [appointments, total] = await Promise.all([
      Appointment.find(filter)
        .populate('staff', 'name avatar')
        .sort({ scheduledAt: 1 }).skip((page - 1) * limit).limit(Number(limit)),
      Appointment.countDocuments(filter),
    ]);
    res.status(200).json({ success: true, data: appointments, pagination: { total, page: Number(page), limit: Number(limit) } });
  } catch (err) { next(err); }
};

exports.createAppointment = async (req, res, next) => {
  try {
    const appointment = await Appointment.create({ ...req.body, companyId: req.companyId, createdBy: req.user._id });

    // Auto-generate confirmation draft
    try {
      const confirmDraft = await runAgent('knowledge_assistant',
        `Write a brief, professional appointment confirmation email for: ${appointment.customer?.name || 'Customer'}, scheduled for ${new Date(appointment.scheduledAt).toLocaleString()}, service: ${appointment.title}.`
      );
      appointment.ai = { confirmationDraft: confirmDraft };
      await appointment.save();
    } catch { /* Non-blocking */ }

    res.status(201).json({ success: true, data: appointment });
  } catch (err) { next(err); }
};

exports.getAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findOne({ _id: req.params.id, companyId: req.companyId }).populate('staff', 'name email');
    if (!appt) return next(new AppError('Appointment not found.', 404));
    res.status(200).json({ success: true, data: appt });
  } catch (err) { next(err); }
};

exports.updateAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findOneAndUpdate(
      { _id: req.params.id, companyId: req.companyId },
      req.body, { new: true, runValidators: true }
    );
    if (!appt) return next(new AppError('Appointment not found.', 404));
    res.status(200).json({ success: true, data: appt });
  } catch (err) { next(err); }
};

exports.deleteAppointment = async (req, res, next) => {
  try {
    const appt = await Appointment.findOneAndDelete({ _id: req.params.id, companyId: req.companyId });
    if (!appt) return next(new AppError('Appointment not found.', 404));
    res.status(200).json({ success: true, message: 'Appointment deleted.' });
  } catch (err) { next(err); }
};

exports.getUpcoming = async (req, res, next) => {
  try {
    const appointments = await Appointment.find({
      companyId: req.companyId,
      scheduledAt: { $gte: new Date() },
      status: { $in: ['pending', 'confirmed'] },
    }).populate('staff', 'name').sort({ scheduledAt: 1 }).limit(10);
    res.status(200).json({ success: true, data: appointments });
  } catch (err) { next(err); }
};
