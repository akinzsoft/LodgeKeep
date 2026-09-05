/**
 * Triggers a browser save-as for an already-fetched `Blob` — PLAN.md Phase 3's
 * report CSV exports. A plain `<a href>` cannot carry an Authorization
 * header, so the file has to be fetched authenticated first
 * (`shared/api/client.js`'s `requestBlob`) and then handed to the browser
 * this way: an object URL plus a synthetic, never-appended-to-the-DOM click.
 */
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
