'use strict';

/**
 * Menu item photos — upload, storage, and the public route that serves them.
 *
 * Stored on local disk (`MENU_IMAGE_STORAGE_DIR`, default
 * `backend/storage/menu-images`, gitignored), the same no-object-storage
 * choice the import and export modules already made.
 *
 * Served WITHOUT authentication (`GET /api/v1/media/menu-items/:file`): the
 * guest QR menu runs on an anonymous phone with no token that could
 * authorize an <img> request. That is safe only because:
 * - the file name is a random UUID generated here — no tenant, property,
 *   or item id appears in the URL, so images cannot be enumerated;
 * - the route accepts only names matching that exact shape (no paths, no
 *   traversal) and serves nothing else from the directory;
 * - uploads are checked by their actual bytes (JPEG/PNG/WebP signatures),
 *   not the client's claimed MIME type, and served with `nosniff`, so an
 *   uploaded HTML or script file can never be served as one.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const { ValidationError } = require('../../shared/errors');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FILE_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const PUBLIC_PREFIX = '/api/v1/media/menu-items/';

function storageDir() {
  const dir = process.env.MENU_IMAGE_STORAGE_DIR || path.join(__dirname, '../../../storage/menu-images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The image type from the file's own leading bytes, or null if it is not a JPEG, PNG, or WebP. */
function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

/** Validates and writes an uploaded image; returns its new random file name. */
function saveImage(buffer) {
  const type = sniffImageType(buffer);
  if (!type) {
    throw new ValidationError('INVALID_IMAGE', 'The photo must be a JPG, PNG, or WebP image.', [{ field: 'image', issue: 'unsupported_type' }]);
  }
  const fileName = `${crypto.randomUUID()}.${type}`;
  fs.writeFileSync(path.join(storageDir(), fileName), buffer, { flag: 'wx' });
  return fileName;
}

/** Best-effort removal of a replaced or removed image — a leftover file is harmless, a failed request over one is not. */
function deleteImage(fileName) {
  if (!fileName || !FILE_NAME_PATTERN.test(fileName)) return;
  fs.rm(path.join(storageDir(), fileName), { force: true }, () => {});
}

function imageUrl(fileName) {
  return fileName ? `${PUBLIC_PREFIX}${fileName}` : null;
}

/** Adds `image_url` to a menu item row for API responses. */
function withImageUrl(row) {
  return row ? { ...row, image_url: imageUrl(row.image_path) } : row;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });

/** `upload.single('image')`, with multer's own errors (too large, wrong field) turned into ordinary 400s. */
function receiveImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) {
      if (!req.file) return next(new ValidationError('MISSING_FIELD', 'Choose a photo to upload.', [{ field: 'image', issue: 'missing' }]));
      return next();
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('IMAGE_TOO_LARGE', 'The photo must be 2 MB or smaller.', [{ field: 'image', issue: 'too_large' }]));
    }
    return next(new ValidationError('INVALID_UPLOAD', 'Upload a single photo in the "image" field.', [{ field: 'image', issue: 'invalid' }]));
  });
}

/** The public, unauthenticated image route — see this file's header for why that is safe. */
function menuImageMediaRouter() {
  const router = Router();
  router.get('/menu-items/:fileName', (req, res) => {
    const { fileName } = req.params;
    const match = FILE_NAME_PATTERN.exec(fileName);
    if (!match) return res.status(404).end();
    const filePath = path.join(storageDir(), fileName);
    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) return res.status(404).end();
      res
        .status(200)
        .set('Content-Type', CONTENT_TYPES[match[1]])
        .set('Content-Length', String(stats.size))
        .set('X-Content-Type-Options', 'nosniff')
        .set('Content-Security-Policy', "default-src 'none'")
        // A name is never reused (a new upload gets a new name), so it can cache forever.
        .set('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(filePath).pipe(res);
    });
  });
  return router;
}

module.exports = {
  MAX_IMAGE_BYTES,
  sniffImageType,
  saveImage,
  deleteImage,
  imageUrl,
  withImageUrl,
  receiveImage,
  menuImageMediaRouter,
};
