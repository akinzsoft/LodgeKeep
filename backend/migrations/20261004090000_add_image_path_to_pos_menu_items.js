'use strict';

/**
 * `pos_menu_items.image_path` — the stored file name of an item's photo,
 * shown on the Register and the guest QR menu.
 *
 * Only the random file name is stored (`<uuid>.<ext>`, see
 * `src/modules/pos/menu-images.js`), never a URL or a path containing
 * tenant, property, or item ids: images are served from a public route so
 * a guest's phone can load them, and an unguessable name is what keeps
 * them from being enumerated. `pos_menu_items`' original migration dropped
 * DATABASE.md's `photo_url` draft for having no caller; this is that caller.
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.string('image_path', 80).nullable().comment('Random stored file name of the item photo, served at /api/v1/media/menu-items/<image_path>.');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('pos_menu_items', (table) => {
    table.dropColumn('image_path');
  });
};
