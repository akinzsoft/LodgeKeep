/**
 * The contact buttons the landing page can show, built from `content.contact`.
 * A channel left empty is simply omitted, so nothing links to a blank number.
 */
export function buildContactLinks(contact) {
  const links = [];
  const whatsapp = String(contact.whatsapp ?? '').replace(/\D/g, '');
  if (whatsapp) {
    links.push({ id: 'whatsapp', label: 'Chat on WhatsApp', href: `https://wa.me/${whatsapp}?text=${encodeURIComponent(contact.whatsappMessage ?? '')}`, external: true });
  }
  const email = String(contact.email ?? '').trim();
  if (email) {
    links.push({ id: 'email', label: 'Send an email', href: `mailto:${email}?subject=${encodeURIComponent('LodgeKeep demo request')}`, external: false });
  }
  const phone = String(contact.phone ?? '').replace(/[^\d+]/g, '');
  if (phone) {
    links.push({ id: 'phone', label: 'Call us', href: `tel:${phone}`, external: false });
  }
  return links;
}
