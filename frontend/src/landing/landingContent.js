/**
 * Everything the marketing landing page says and shows, in one place — edit
 * the words, swap an image, add a video or a testimonial here and nowhere else.
 *
 * HOW TO REFINE
 *  - Copy: change any string below.
 *  - Screenshots: replace a file in `./assets/` (keep the filename) or import a
 *    new one and point `image` at it. Wide 16:8 captures work best.
 *  - Demo video: set `video.src` to a file you put in `frontend/public/`
 *    (for example '/lodgekeep-demo.mp4') and, optionally, `video.poster`.
 *    Self-hosted files only: the page's security policy blocks YouTube/Vimeo
 *    embeds unless `docker/frontend/Caddyfile` is changed on purpose.
 *  - Testimonials: add `{ quote, name, role }` entries to `testimonials`.
 *  - Contact: fill `contact` — each channel you leave empty simply hides its
 *    button. Numbers go in international form without symbols (234…).
 *
 * TRUTH RULES (keep it honest): only claim what the app does today. Not built,
 * so NOT claimed anywhere: channel manager / OTA sync, loyalty programme,
 * dynamic pricing, offline queueing of sales, iPhone camera scanning, any
 * certification or compliance badge, uptime figures, customer counts.
 */

import dashboardImage from './assets/dashboard.webp';
import tapeChartImage from './assets/tape-chart.webp';
import posImage from './assets/pos-register.webp';
import supermarketImage from './assets/supermarket-till.webp';
import reportsImage from './assets/reports.webp';

export const content = {
  brand: 'LodgeKeep',
  company: 'Planmsys Ltd',
  companyUrl: 'https://www.planmsys.com',
  pageTitle: 'LodgeKeep — hotel, POS and supermarket management for Nigeria',
  pageDescription:
    'LodgeKeep runs your hotel, bar, restaurant and mini-mart from one system: bookings, front desk, POS, stock, a barcode-scanning till and Paystack payments, in Naira.',

  hero: {
    kicker: 'Hotel & supermarket management for Nigeria',
    // The hyphen in mini\u2011mart is non-breaking, so the word never splits across lines.
    headline: 'Run your hotel, bar and mini\u2011mart from one system',
    subhead:
      'Reservations, front desk, POS, stock and a barcode-scanning supermarket till — with Naira, Paystack and your own bank accounts built in.',
    primaryCta: 'Start free trial',
    secondaryCta: 'Request a demo',
    reassurance: '14-day free trial · No card needed to start',
    image: dashboardImage,
    imageAlt: 'The LodgeKeep dashboard showing occupancy, ADR, RevPAR and today’s arrivals and departures',
  },

  trust: {
    label: 'Built for how Nigerian businesses get paid',
    items: ['Naira (NGN)', 'Paystack', 'Moniepoint · OPay · GTBank terminals', 'NQR scan-to-pay', 'Cash'],
  },

  features: [
    {
      id: 'hotel',
      title: 'Hotel PMS and booking',
      lead: 'From the first enquiry to the final bill, in one calm screen.',
      points: [
        'Availability search, a tape chart by room type and a waitlist',
        'Check-in, check-out, room moves and extended stays at the front desk',
        'Guest folios with split billing, taxes and a balance that must be cleared before check-out',
        'A mobile housekeeping board, night audit and company accounts with credit limits',
      ],
      image: tapeChartImage,
      imageAlt: 'The tape chart showing how many rooms of each type are free on every night',
    },
    {
      id: 'pos',
      title: 'POS for your bar and restaurant',
      lead: 'A fast, touch-friendly register your staff will pick up in minutes.',
      points: [
        'Tabs, split bills, kitchen and bar tickets and charge-to-room',
        'Stock comes off the shelf with every sale; transfers and requests from the store room',
        'Cash-up shifts, tips and service charge, and profit on every report',
        'Guests can order from their table or room by scanning a QR code',
      ],
      image: posImage,
      imageAlt: 'The POS register with a bar menu, an open ticket and cash, card, NQR and card-terminal payment options',
    },
    {
      id: 'supermarket',
      title: 'A supermarket till that scans',
      lead: 'Sell a basket in seconds and always know what is on the shelf.',
      points: [
        'Scan with a barcode scanner or an Android phone camera, or search by name',
        'Printable receipts with gapless numbers, cash or card-terminal payment',
        'Bulk-load your products from a spreadsheet, with low-stock warnings',
        'Customers can pay online by card or by scanning a QR code on their own phone',
      ],
      image: supermarketImage,
      imageAlt: 'The supermarket till with a product grid, a current sale and payment options',
    },
    {
      id: 'reports',
      title: 'Reports you can trust',
      lead: 'Numbers that add up, because they come from the same ledger as the till.',
      points: [
        'Occupancy, revenue, ADR and RevPAR, day by day',
        'Profit and loss with cost of sales, and expenses including recurring ones',
        'Payment reconciliation by method, terminal and bank account',
        'Export to a spreadsheet or save as a PDF',
      ],
      image: reportsImage,
      imageAlt: 'The revenue report listing room revenue, rooms sold, ADR, RevPAR and payments collected for each day',
    },
  ],

  payments: {
    title: 'Every way your customers pay',
    lead: 'Money lands where it should, and every payment is recorded against the right account.',
    methods: [
      { id: 'paystack', title: 'Online with Paystack', text: 'Card or transfer, on the till, a popup on the page, or a link the guest opens on their phone.' },
      { id: 'terminal', title: 'Card terminals', text: 'Record Moniepoint, OPay and GTBank terminal payments against the account each outlet banks into.' },
      { id: 'nqr', title: 'NQR scan-to-pay', text: 'Show a QR code and let the customer pay from their own banking app.' },
      { id: 'cash', title: 'Cash, with proper cash-up', text: 'Cash is counted blind at the end of every shift, so a short till shows up the same day.' },
    ],
    note: 'Each outlet can settle online payments into its own bank account.',
  },

  gallery: {
    title: 'See it in action',
    lead: 'Real screens from a working LodgeKeep, with demo data.',
    items: [
      { id: 'dashboard', image: dashboardImage, caption: 'Dashboard', alt: 'The LodgeKeep dashboard' },
      { id: 'tape', image: tapeChartImage, caption: 'Tape chart', alt: 'The tape chart of free rooms by night' },
      { id: 'pos', image: posImage, caption: 'POS register', alt: 'The POS register' },
      { id: 'till', image: supermarketImage, caption: 'Supermarket till', alt: 'The supermarket till' },
      { id: 'reports', image: reportsImage, caption: 'Revenue report', alt: 'The revenue report' },
    ],
  },

  video: {
    title: 'Watch a two-minute walkthrough',
    lead: 'A quick tour from booking to bill.',
    // Put an MP4 in frontend/public/ and set src, e.g. '/lodgekeep-demo.mp4'. Empty = placeholder.
    src: '',
    poster: '',
    placeholderText: 'The demo video is coming soon.',
  },

  testimonials: {
    title: 'What our customers say',
    // Add { quote, name, role } entries. Empty = a placeholder card.
    items: [],
    placeholder: { quote: 'Your customer’s words go here — a sentence or two about what changed for them.', name: 'Customer name', role: 'Hotel or mart, city' },
  },

  pricing: {
    title: 'One simple plan',
    lead: 'Everything in LodgeKeep for one flat monthly price.',
    planName: 'Standard',
    amount: '50000.00',
    currency: 'NGN',
    interval: 'per month, per organisation',
    trial: '14-day free trial · no card needed to start',
    // CONFIRM these commercial statements with Planmsys before publishing.
    includes: [
      'Hotel PMS, front desk, housekeeping, cashiering and night audit',
      'POS for bars and restaurants, with stock control',
      'Supermarket till with barcode scanning',
      'Paystack online payments, card-terminal records and NQR',
      'Reports, profit and loss and payment reconciliation',
      'More than one property on the same account',
      'No per-room or per-user fees',
    ],
    cta: 'Start free trial',
  },

  contact: {
    title: 'Talk to us or request a demo',
    lead: 'Tell us about your hotel or mart and we will show you LodgeKeep working with your numbers.',
    // Fill these in. International form, digits only for WhatsApp/phone: '2348012345678'.
    whatsapp: '',
    email: '',
    phone: '',
    whatsappMessage: 'Hello, I would like a demo of LodgeKeep.',
    emptyNotice: 'Contact details have not been added yet — set them in landingContent.js.',
  },

  signIn: {
    title: 'Already a customer?',
    lead: 'Enter your company’s address to go to your sign-in.',
    label: 'Your company address',
    placeholder: 'your-company',
    button: 'Go to my sign-in',
    invalid: 'Use letters, numbers and hyphens only.',
  },

  footer: {
    blurb: 'LodgeKeep is a Planmsys product.',
  },
};
