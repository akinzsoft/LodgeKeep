'use strict';

/**
 * The branded shell every outgoing email is wrapped in — the property's own
 * logo in the header, the message in a white card, and a footer carrying the
 * property's name and address, like a hotel's own correspondence.
 *
 * Email clients are not browsers: layout is table-based with inline styles
 * only (Gmail and Outlook strip <style> blocks and ignore flexbox/grid), the
 * width caps at 600px, and colours are literal hex values because CSS
 * variables do not survive either.
 *
 * The logo travels INSIDE the email as an inline attachment (`cid:`), not as
 * a link back to this server: a link would not load at all from a dev or
 * intranet deployment, and many clients block remote images by default.
 * With no logo uploaded, the property's name is set as a text wordmark.
 *
 * Template content is built from the small helpers below (`heading`,
 * `paragraph`, `details`, `button`, `codeBlock`, `note`) so every default
 * template shares one look. Variables substituted into them are
 * HTML-escaped by `substitute` in `service.js` — a guest name can never
 * inject markup.
 */

const fs = require('fs');
const imageStore = require('../../shared/image-store');

const LOGO_CID = 'property-logo';

/** The email header's logo area: wide logos fill the width, tall or square ones the height. */
const LOGO_BOX = { width: 240, height: 72 };

/** The first bytes of a file — enough for any image header readImageSize needs. */
function readHead(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

const COLORS = {
  page: '#F4F1EA',
  card: '#FFFFFF',
  border: '#EAE4D6',
  text: '#1F2A26',
  muted: '#5C6B66',
  accent: '#8A6D3B',
  accentText: '#FFFFFF',
  codeBg: '#FAF8F4',
};

const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// Content helpers — used by DEFAULT_TEMPLATES. Arguments may contain
// `{{placeholders}}`; they are substituted (and escaped) afterwards.
// ---------------------------------------------------------------------

function heading(text) {
  return `<h1 style="margin:0 0 16px;font-family:${SERIF};font-size:24px;line-height:1.3;font-weight:600;color:${COLORS.text};">${text}</h1>`;
}

function paragraph(text) {
  return `<p style="margin:0 0 16px;font-family:${FONT};font-size:16px;line-height:1.6;color:${COLORS.text};">${text}</p>`;
}

function note(text) {
  return `<p style="margin:16px 0 0;font-family:${FONT};font-size:13px;line-height:1.5;color:${COLORS.muted};">${text}</p>`;
}

/** A two-column label/value summary, e.g. a booking's dates and confirmation number. */
function details(rows) {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:10px 16px;font-family:${FONT};font-size:14px;color:${COLORS.muted};border-bottom:1px solid ${COLORS.border};">${label}</td>` +
        `<td style="padding:10px 16px;font-family:${FONT};font-size:14px;font-weight:600;color:${COLORS.text};text-align:right;border-bottom:1px solid ${COLORS.border};">${value}</td></tr>`
    )
    .join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;border:1px solid ${COLORS.border};border-radius:8px;border-collapse:separate;">${body}</table>`;
}

/** A call-to-action button (bulletproof table button — renders in Outlook too). */
function button(href, label) {
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr>` +
    `<td style="border-radius:6px;background:${COLORS.accent};">` +
    `<a href="${href}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;font-weight:600;color:${COLORS.accentText};text-decoration:none;border-radius:6px;">${label}</a>` +
    `</td></tr></table>`
  );
}

/** A large, spaced one-time code. */
function codeBlock(code) {
  return (
    `<div style="margin:8px 0 24px;padding:20px;border:1px dashed ${COLORS.accent};border-radius:8px;background:${COLORS.codeBg};text-align:center;` +
    `font-family:'Courier New', Courier, monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:${COLORS.text};">${code}</div>`
  );
}

// ---------------------------------------------------------------------
// Branding + shell
// ---------------------------------------------------------------------

/**
 * The property's name, address, and logo for an email. `db` must be scoped
 * to `propertyId`. Returns `{ name, address, logoAttachment }`, where
 * `logoAttachment` is a nodemailer inline attachment, or null when no
 * uploaded logo exists on disk.
 */
async function loadEmailBranding({ db, propertyId }) {
  if (!db || !propertyId) return { name: null, address: null, logoAttachment: null };
  const property = await db.table('properties').where({ id: propertyId }).first('name', 'address', 'logo_url');
  const fileName = imageStore.fileNameFromUrl('property-logos', property?.logo_url);
  const filePath = imageStore.imageFilePath('property-logos', fileName);
  const extension = fileName ? fileName.split('.').pop() : null;
  // Exact display size inside the header's logo box, from the file's own header bytes.
  const logoSize = filePath ? imageStore.fitInside(imageStore.readImageSize(readHead(filePath)), LOGO_BOX.width, LOGO_BOX.height) : null;
  return {
    name: property?.name ?? null,
    address: property?.address ?? null,
    logoSize,
    logoAttachment: filePath
      ? { filename: `logo.${extension}`, path: filePath, cid: LOGO_CID, contentType: imageStore.CONTENT_TYPES[extension], contentDisposition: 'inline' }
      : null,
  };
}

/**
 * Wraps rendered message content in the branded shell. `contentHtml` is
 * already-substituted, already-escaped template output; `branding` comes
 * from `loadEmailBranding`. `preheader` is the hidden preview line inboxes
 * show beside the subject.
 */
function renderEmailShell({ subject, contentHtml, branding, preheader }) {
  const name = branding?.name ? escapeHtml(branding.name) : 'LodgeKeep';
  const size = branding?.logoSize ?? { width: 200, height: 56 };
  const header = branding?.logoAttachment
    ? `<img src="cid:${LOGO_CID}" alt="${name}" width="${size.width}" height="${size.height}" style="display:block;margin:0 auto;width:${size.width}px;height:${size.height}px;border:0;outline:none;text-decoration:none;">`
    : `<span style="font-family:${SERIF};font-size:26px;font-weight:600;letter-spacing:0.5px;color:${COLORS.text};">${name}</span>`;
  const address = branding?.address
    ? `<p style="margin:4px 0 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(branding.address)}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLORS.page};">${escapeHtml(preheader ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};">
<tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;">
<tr><td align="center" style="padding:0 0 24px;">${header}</td></tr>
<tr><td style="background:${COLORS.card};border:1px solid ${COLORS.border};border-top:4px solid ${COLORS.accent};border-radius:10px;padding:36px 32px;">
${contentHtml}
</td></tr>
<tr><td align="center" style="padding:24px 16px 0;">
<p style="margin:0;font-family:${FONT};font-size:13px;font-weight:600;color:${COLORS.text};">${name}</p>
${address}
<p style="margin:12px 0 0;font-family:${FONT};font-size:11px;color:${COLORS.muted};">Sent by ${name} · Powered by LodgeKeep</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** First readable sentence of the content, for the inbox preview line. */
function preheaderFrom(contentHtml) {
  const text = contentHtml.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const decoded = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return decoded.length > 110 ? `${decoded.slice(0, 107)}…` : decoded;
}

module.exports = {
  LOGO_CID,
  escapeHtml,
  heading,
  paragraph,
  note,
  details,
  button,
  codeBlock,
  loadEmailBranding,
  renderEmailShell,
  preheaderFrom,
};
