'use strict';

const fs = require('fs');
const { cloudinary } = require('../config/cloudinary');

// Stores an uploaded logo (req.file from multer) and returns its public URL.
async function storeBrandImage(req) {
  if (cloudinary) {
    const r = await cloudinary.uploader.upload(req.file.path, {
      folder: `business-ai/${req.companyId}/branding`,
      resource_type: 'image',
      transformation: [{ width: 500, height: 500, crop: 'limit' }],
    });
    fs.unlink(req.file.path, () => {});
    return r.secure_url;
  }
  return `${(process.env.API_URL || '').replace(/\/+$/, '')}/uploads/temp/${req.file.path.split(/[\\/]/).pop()}`;
}

module.exports = { storeBrandImage };
