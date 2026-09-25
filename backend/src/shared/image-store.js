'use strict';

/**
 * Uploaded images — menu item photos and property logos — stored on local
 * disk and served from one public route, `GET /api/v1/media/:kind/:file`.
 * Promoted out of `modules/pos/menu-images.js` once property logos needed
 * the identical upload/storage/serving rules.
 *
 * Served WITHOUT authentication: a guest's phone loading the QR menu, or an
 * email client, has no token that could authorize an <img> request. That is
 * safe only because:
 * - file names are random UUIDs generated here — no tenant, property, or
 *   record id appears in a URL, so images cannot be enumerated;
 * - the route accepts only names matching that exact shape, for a fixed set
 *   of kinds (no paths, no traversal), and serves nothing else;
 * - uploads are checked by their actual bytes (JPEG/PNG/WebP signatures),
 *   never the client's claimed MIME type, and served with `nosniff` and a
 *   `default-src 'none'` CSP, so no upload can be served as HTML or script.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Router } = require('express');
const multer = require('multer');
const { ValidationError } = require('./errors');

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const FILE_NAME_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;
const CONTENT_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MEDIA_PREFIX = '/api/v1/media/';

/** Each kind of image: its URL segment and its storage directory (overridable per environment). */
const KINDS = {
  'menu-items': { envVar: 'MENU_IMAGE_STORAGE_DIR', defaultDir: 'menu-images' },
  'property-logos': { envVar: 'PROPERTY_LOGO_STORAGE_DIR', defaultDir: 'property-logos' },
};

function storageDir(kind) {
  const config = KINDS[kind];
  if (!config) throw new Error(`Unknown image kind "${kind}".`);
  const dir = process.env[config.envVar] || path.join(__dirname, '../../storage', config.defaultDir);
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

/**
 * Pixel width/height from an image's own header — PNG (IHDR), JPEG (the
 * first start-of-frame marker), WebP (VP8 / VP8L / VP8X) — or null when it
 * cannot be read. Used to give email logos exact dimensions: email clients
 * (Outlook especially) ignore max-width/max-height, so a logo without real
 * width/height attributes gets stretched or overflows.
 */
function readImageSize(buffer) {
  const type = sniffImageType(buffer);
  try {
    if (type === 'png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (type === 'jpg') {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        // SOF0..SOF15, excluding DHT (C4), JPG (C8), and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
      return null;
    }
    if (type === 'webp' && buffer.length >= 30) {
      const chunk = buffer.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
    }
  } catch {
    return null;
  }
  return null;
}

/** Scales `size` to fit inside a `maxWidth` × `maxHeight` box, never enlarging it, keeping its aspect ratio. */
function fitInside(size, maxWidth, maxHeight) {
  if (!size || !size.width || !size.height) return null;
  const scale = Math.min(maxWidth / size.width, maxHeight / size.height, 1);
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/** Validates and writes an uploaded image; returns its new random file name. */
function saveImage(kind, buffer) {
  const type = sniffImageType(buffer);
  if (!type) {
    throw new ValidationError('INVALID_IMAGE', 'The image must be a JPG, PNG, or WebP file.', [{ field: 'image', issue: 'unsupported_type' }]);
  }
  const fileName = `${crypto.randomUUID()}.${type}`;
  fs.writeFileSync(path.join(storageDir(kind), fileName), buffer, { flag: 'wx' });
  return fileName;
}

/** Best-effort removal of a replaced or removed image — a leftover file is harmless, a failed request over one is not. */
function deleteImage(kind, fileName) {
  if (!fileName || !FILE_NAME_PATTERN.test(fileName)) return;
  fs.rm(path.join(storageDir(kind), fileName), { force: true }, () => {});
}

/**
 * STRICT removal, for the tenant retention purge: unlike `deleteImage` it is
 * synchronous and reports the truth. Returns `true` when a file was removed and
 * `false` when there was nothing to remove (an invalid name, or already gone);
 * any OTHER failure (permissions, I/O) throws, so a purge can count and surface
 * it instead of silently leaving a customer's photo on a public URL.
 */
function removeImageStrict(kind, fileName) {
  if (!fileName || !FILE_NAME_PATTERN.test(fileName)) return false;
  try {
    fs.rmSync(path.join(storageDir(kind), fileName));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function imageUrl(kind, fileName) {
  return fileName ? `${MEDIA_PREFIX}${kind}/${fileName}` : null;
}

/** The absolute path of a stored image, or null if the name is not a valid stored file name or the file is missing. */
function imageFilePath(kind, fileName) {
  if (!fileName || !FILE_NAME_PATTERN.test(fileName)) return null;
  const filePath = path.join(storageDir(kind), fileName);
  return fs.existsSync(filePath) ? filePath : null;
}

/** The stored file name inside one of this module's own public URLs, or null for anything else (e.g. an external URL). */
function fileNameFromUrl(kind, url) {
  if (typeof url !== 'string' || !url.startsWith(`${MEDIA_PREFIX}${kind}/`)) return null;
  const fileName = url.slice(`${MEDIA_PREFIX}${kind}/`.length);
  return FILE_NAME_PATTERN.test(fileName) ? fileName : null;
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 } });

/** `upload.single('image')`, with multer's own errors (too large, wrong field) turned into ordinary 400s. */
function receiveImage(req, res, next) {
  upload.single('image')(req, res, (error) => {
    if (!error) {
      if (!req.file) return next(new ValidationError('MISSING_FIELD', 'Choose an image to upload.', [{ field: 'image', issue: 'missing' }]));
      return next();
    }
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('IMAGE_TOO_LARGE', 'The image must be 2 MB or smaller.', [{ field: 'image', issue: 'too_large' }]));
    }
    return next(new ValidationError('INVALID_UPLOAD', 'Upload a single image in the "image" field.', [{ field: 'image', issue: 'invalid' }]));
  });
}

/** The public, unauthenticated image route — see this file's header for why that is safe. */
function mediaRouter() {
  const router = Router();
  router.get('/:kind/:fileName', (req, res) => {
    const { kind, fileName } = req.params;
    const match = FILE_NAME_PATTERN.exec(fileName);
    if (!KINDS[kind] || !match) return res.status(404).end();
    const filePath = path.join(storageDir(kind), fileName);
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
  CONTENT_TYPES,
  sniffImageType,
  readImageSize,
  fitInside,
  saveImage,
  deleteImage,
  removeImageStrict,
  imageUrl,
  imageFilePath,
  fileNameFromUrl,
  receiveImage,
  mediaRouter,
};
