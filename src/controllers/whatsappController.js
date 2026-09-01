// 'use strict';

// const whatsappService = require('../services/whatsappService');
// const logger = require('../utils/logger');

// exports.getStatus = async (req, res) => {
//   const { status, qrCode } = whatsappService.getStatus();
//   res.status(200).json({ success: true, data: { status, qrCode } });
// };

// exports.initialize = async (req, res) => {
//   try {
//     const io = req.app.get('io');
//     whatsappService.initialize(io);
//     res.status(200).json({ success: true, message: 'WhatsApp initialization started. Scan the QR code.' });
//   } catch (err) {
//     res.status(500).json({ success: false, message: err.message });
//   }
// };

// exports.disconnect = async (req, res) => {
//   try {
//     await whatsappService.disconnect();
//     res.status(200).json({ success: true, message: 'WhatsApp disconnected.' });
//   } catch (err) {
//     res.status(500).json({ success: false, message: err.message });
//   }
// };

// exports.sendTest = async (req, res) => {
//   try {
//     const { phone } = req.body;
//     if (!phone) return res.status(400).json({ success: false, message: 'Phone number required' });

//     const result = await whatsappService.sendMessage(phone,
//       `✅ *Test Message*\n\nHello! This is a test message from *EngrHenryTech BusinessAI*.\n\nYour WhatsApp integration is working perfectly! 🎉\n\n_Powered by EngrHenryTech BusinessAI_ ⚡`
//     );

//     if (result.success) {
//       res.status(200).json({ success: true, message: `Test message sent to ${phone}` });
//     } else {
//       res.status(400).json({ success: false, message: result.reason });
//     }
//   } catch (err) {
//     res.status(500).json({ success: false, message: err.message });
//   }
// };