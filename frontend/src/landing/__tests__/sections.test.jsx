import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { content as realContent } from '../landingContent.js';
import { Contact, FindCompany, Gallery, Pricing, Testimonials, VideoSection, Hero, Header, Footer } from '../sections.jsx';
import { buildContactLinks } from '../contactLinks.js';
import LandingApp from '../LandingApp.jsx';

const withContent = (patch) => ({ ...realContent, ...patch });

afterEach(cleanup);

describe('landing page sections', () => {
  it('the whole page renders every section, once, with one h1', () => {
    render(<LandingApp />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/hotel, bar and mini.mart from one system/i);
    for (const title of [/Hotel PMS and booking/, /POS for your bar and restaurant/, /A supermarket till that scans/, /Reports you can trust/, /Every way your customers pay/, /See it in action/, /two-minute walkthrough/, /What our customers say/, /Simple, honest pricing/, /Already a customer\?/, /Talk to us or request a demo/]) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    }
    expect(document.title).toBe(realContent.pageTitle);
    expect(document.querySelector('meta[name="description"]').getAttribute('content')).toBe(realContent.pageDescription);
  });

  it('every call to action goes to the existing signup', () => {
    render(<LandingApp />);
    const trial = screen.getAllByRole('link', { name: /start free trial/i });
    expect(trial.length).toBeGreaterThanOrEqual(3);
    for (const link of trial) expect(link).toHaveAttribute('href', '/signup');
  });

  it('the hero and header never offer a login of their own — "Sign in" jumps to the find-your-company form', () => {
    render(<LandingApp />);
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: /^sign in$/i })) expect(link).toHaveAttribute('href', '#sign-in');
  });

  it('the pricing shows the one real plan in Naira, with the trial', () => {
    render(<Pricing content={realContent} />);
    expect(screen.getByText(/500,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/one-time setup fee/)).toBeInTheDocument();
    expect(screen.getByText(/35,000\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/50,000\.00/)).not.toBeInTheDocument();
    expect(screen.getByText('No per-room or per-user fees')).toBeInTheDocument();
    expect(screen.getByText('Multiple properties on one account')).toBeInTheDocument();
    expect(screen.getByText(/14-day free trial/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /start free trial/i })).toHaveAttribute('href', '/signup');
  });

  it('claims nothing the app does not do', () => {
    render(<LandingApp />);
    const text = document.body.textContent;
    for (const bannedClaim of [/channel manager/i, /\bOTA\b/, /booking\.com/i, /loyalty/i, /dynamic pricing/i, /iphone/i, /\bISO\b/, /GDPR|NDPA/, /99\.\d+%/, /uptime/i, /works offline/i, /unlimited/i]) {
      expect(text).not.toMatch(bannedClaim);
    }
  });
});

describe('contact', () => {
  it('shows only the channels that were filled in, as real links', () => {
    const contact = { ...realContent.contact, whatsapp: '+234 801 234 5678', email: 'hello@example.com', phone: '' };
    render(<Contact content={withContent({ contact })} />);
    const whatsapp = screen.getByRole('link', { name: /whatsapp/i });
    expect(whatsapp.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/2348012345678\?text=/);
    expect(whatsapp).toHaveAttribute('target', '_blank');
    expect(whatsapp).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('link', { name: /email/i }).getAttribute('href')).toMatch(/^mailto:hello@example\.com/);
    expect(screen.queryByRole('link', { name: /call us/i })).not.toBeInTheDocument();
    expect(screen.queryByText(realContent.contact.emptyNotice)).not.toBeInTheDocument();
  });

  it('the real contact details are filled in and link correctly', () => {
    render(<Contact content={realContent} />);
    expect(screen.getByRole('link', { name: /whatsapp/i }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/2347031308712\?text=/);
    expect(screen.getByRole('link', { name: /email/i })).toHaveAttribute('href', expect.stringMatching(/^mailto:info@planmsys\.com/));
    expect(screen.getByRole('link', { name: /call/i })).toHaveAttribute('href', 'tel:2347031308712');
    expect(screen.queryByText(realContent.contact.emptyNotice)).not.toBeInTheDocument();
  });

  it('with nothing filled in, says so instead of linking to a blank number', () => {
    const blank = { ...realContent.contact, whatsapp: '', email: '', phone: '' };
    render(<Contact content={withContent({ contact: blank })} />);
    expect(screen.getByText(realContent.contact.emptyNotice)).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('buildContactLinks cleans numbers and skips empty channels', () => {
    expect(buildContactLinks({ whatsapp: '', email: '  ', phone: '' })).toEqual([]);
    const links = buildContactLinks({ whatsapp: '(0801) 234-5678', email: 'a@b.co', phone: '+234 801 234 5678', whatsappMessage: 'Hi there' });
    expect(links.map((link) => link.href)).toEqual(['https://wa.me/08012345678?text=Hi%20there', 'mailto:a@b.co?subject=LodgeKeep%20demo%20request', 'tel:+2348012345678']);
  });
});

describe('find your company (sign in)', () => {
  it('sends a customer to their own address and nowhere else', async () => {
    const navigate = vi.fn();
    render(<FindCompany content={realContent} navigate={navigate} />);
    await userEvent.type(screen.getByLabelText(realContent.signIn.label), 'Stical Hotel Suite');
    await userEvent.click(screen.getByRole('button', { name: realContent.signIn.button }));
    expect(navigate).toHaveBeenCalledTimes(1);
    // The address is the tenant's slug as a subdomain — never a path on this host.
    expect(navigate.mock.calls[0][0]).toMatch(/^https?:\/\/stical-hotel-suite\./);
  });

  it('refuses an empty or unusable name without navigating', async () => {
    const navigate = vi.fn();
    render(<FindCompany content={realContent} navigate={navigate} />);
    await userEvent.click(screen.getByRole('button', { name: realContent.signIn.button }));
    expect(await screen.findByRole('alert')).toHaveTextContent(realContent.signIn.invalid);
    await userEvent.type(screen.getByLabelText(realContent.signIn.label), '!!!');
    await userEvent.click(screen.getByRole('button', { name: realContent.signIn.button }));
    expect(navigate).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(realContent.signIn.label), 'ok-co');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // typing clears the message
  });
});

describe('gallery lightbox', () => {
  it('opens a screenshot full size, and closes on Close, Escape and the backdrop', async () => {
    render(<Gallery content={realContent} />);
    const first = realContent.gallery.items[0];
    await userEvent.click(screen.getByRole('button', { name: `Enlarge: ${first.caption}` }));
    const dialog = screen.getByRole('dialog', { name: first.caption });
    expect(within(dialog).getByRole('img', { name: first.alt })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Enlarge: ${first.caption}` })).toHaveFocus(); // focus returns to the opener

    await userEvent.click(screen.getByRole('button', { name: `Enlarge: ${first.caption}` }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: `Enlarge: ${first.caption}` }));
    await userEvent.click(screen.getByRole('dialog').parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('video and testimonials placeholders', () => {
  it('shows a placeholder until a video file is set, then a self-hosted player', () => {
    const { unmount } = render(<VideoSection content={realContent} />);
    expect(screen.getByRole('img', { name: realContent.video.placeholderText })).toBeInTheDocument();
    expect(document.querySelector('video')).toBeNull();
    unmount();

    const { container } = render(<VideoSection content={withContent({ video: { ...realContent.video, src: '/lodgekeep-demo.mp4', poster: '/poster.webp' } })} />);
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'none'); // nothing downloads until they press play
    expect(container.querySelector('source')).toHaveAttribute('src', '/lodgekeep-demo.mp4');
  });

  it('shows a labelled placeholder testimonial until real ones are added', () => {
    const { unmount } = render(<Testimonials content={realContent} />);
    expect(screen.getByText(realContent.testimonials.placeholder.name)).toBeInTheDocument();
    unmount();
    render(<Testimonials content={withContent({ testimonials: { ...realContent.testimonials, items: [{ quote: 'It paid for itself.', name: 'Ada', role: 'Owner, Lagos' }] } })} />);
    expect(screen.getByText('It paid for itself.')).toBeInTheDocument();
    expect(screen.queryByText(realContent.testimonials.placeholder.name)).not.toBeInTheDocument();
  });
});

describe('hero, header, footer', () => {
  it('lead with the screenshot and the signup, and carry the company footer', () => {
    render(
      <>
        <Header content={realContent} />
        <Hero content={realContent} />
        <Footer content={realContent} />
      </>
    );
    expect(screen.getByRole('img', { name: realContent.hero.imageAlt })).toHaveAttribute('width', '1470');
    expect(screen.getByRole('link', { name: realContent.company })).toHaveAttribute('href', realContent.companyUrl);
    expect(screen.getByText(new RegExp(`${new Date().getFullYear()} ${realContent.company}`))).toBeInTheDocument();
  });
});
