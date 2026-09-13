'use strict';

/**
 * Menu item photos — shown on the Register and the guest QR menu. Storage,
 * validation, and the public media route live in `src/shared/image-store.js`
 * (shared with property logos); this file only binds them to menu items.
 */

const imageStore = require('../../shared/image-store');

const KIND = 'menu-items';

module.exports = {
  MAX_IMAGE_BYTES: imageStore.MAX_IMAGE_BYTES,
  sniffImageType: imageStore.sniffImageType,
  receiveImage: imageStore.receiveImage,
  saveImage: (buffer) => imageStore.saveImage(KIND, buffer),
  deleteImage: (fileName) => imageStore.deleteImage(KIND, fileName),
  imageUrl: (fileName) => imageStore.imageUrl(KIND, fileName),
  /** Adds `image_url` to a menu item row for API responses. */
  withImageUrl: (row) => (row ? { ...row, image_url: imageStore.imageUrl(KIND, row.image_path) } : row),
};
