import { describe, it, expect } from 'vitest';
import { applyOverrides, overridesFromForm, formFromContent, trialLine } from '../contentOverrides.js';

const defaults = {
  hero: { headline: 'Default headline', subhead: 'Default sub', primaryCta: 'Start', secondaryCta: 'Demo', reassurance: '14-day free trial · No card needed to start', image: '/hero.webp' },
  pricing: { title: 'Pricing', lead: 'Lead', setupAmount: '500000.00', setupLabel: 'one-time setup fee', amount: '35000.00', currency: 'NGN', interval: 'per month', trial: '14-day free trial · no card needed to start', includes: ['A', 'B'] },
  contact: { title: 'Talk', lead: 'Lead', whatsapp: '2347031308712', phone: '2347031308712', email: 'info@planmsys.com', whatsappMessage: 'Hello' },
  testimonials: { items: [], placeholder: { name: 'Your customer' } },
  video: { src: '', poster: '', title: 'Watch' },
  features: [{ title: 'Hotel' }],
};

describe('applyOverrides', () => {
  it('returns the defaults, unchanged and not the same objects, when there is nothing saved', () => {
    for (const payload of [undefined, null, 'x', {}, { overrides: {} }, { overrides: null }]) {
      const content = applyOverrides(defaults, payload);
      expect(content).toEqual(defaults);
      expect(content.hero).not.toBe(defaults.hero);
    }
  });

  it('applies saved text, contact, setup fee, includes, testimonials and video', () => {
    const content = applyOverrides(defaults, {
      overrides: {
        hero: { headline: 'New headline' },
        pricing: { setupAmount: '750000.00', includes: ['X'] },
        contact: { whatsapp: '2348000000000', email: '' },
        testimonials: { items: [{ quote: 'Great', name: 'Ada', role: 'Owner' }] },
        video: { src: '/demo.mp4' },
      },
    });
    expect(content.hero.headline).toBe('New headline');
    expect(content.hero.subhead).toBe('Default sub');
    expect(content.pricing.setupAmount).toBe('750000.00');
    expect(content.pricing.includes).toEqual(['X']);
    expect(content.contact).toMatchObject({ whatsapp: '2348000000000', email: '', phone: '2347031308712' });
    expect(content.testimonials.items).toHaveLength(1);
    expect(content.video.src).toBe('/demo.mp4');
    expect(defaults.hero.headline).toBe('Default headline');
  });

  it('the monthly fee and trial come ONLY from the live facts, never from overrides', () => {
    const content = applyOverrides(defaults, {
      overrides: { pricing: { amount: '1.00', trial: '90 days free', currency: 'USD' }, hero: { reassurance: 'Free forever' } },
      monthly: { amount: '41000.00', currency: 'NGN', interval: 'monthly' },
      trialDays: 7,
    });
    expect(content.pricing).toMatchObject({ amount: '41000.00', currency: 'NGN', interval: 'per month', trial: trialLine(7) });
    expect(content.hero.reassurance).toBe('7-day free trial · No card needed to start');
  });

  it('with no live facts it keeps the defaults for them', () => {
    const content = applyOverrides(defaults, { overrides: {}, monthly: null, trialDays: null });
    expect(content.pricing.amount).toBe('35000.00');
    expect(content.pricing.trial).toBe(defaults.pricing.trial);
  });

  it('ignores values of the wrong shape and unknown keys', () => {
    const content = applyOverrides(defaults, {
      overrides: {
        hero: { headline: '   ', subhead: 42, nope: 'x' },
        pricing: { includes: [], setupLabel: null },
        contact: { whatsapp: 7 },
        testimonials: { items: [{ quote: 'q' }] },
        evil: { a: 1 },
      },
      trialDays: 'lots',
    });
    expect(content).toEqual(defaults);
  });

  it('never lets an override touch non-editable parts (images, features)', () => {
    const content = applyOverrides(defaults, { overrides: { hero: { image: 'https://evil.example/x.png' }, features: [{ title: 'Hacked' }] } });
    expect(content.hero.image).toBe('/hero.webp');
    expect(content.features).toEqual(defaults.features);
  });
});

describe('overridesFromForm', () => {
  it('an untouched form saves nothing', () => {
    expect(overridesFromForm(formFromContent(defaults), defaults)).toEqual({});
  });

  it('saves only what differs from the defaults', () => {
    const form = formFromContent(defaults);
    form.hero.headline = '  Changed  ';
    form.pricing.includes = ['A', '', 'C'];
    form.testimonials.items = [{ quote: ' Great ', name: 'Ada', role: '' }, { quote: '', name: '', role: '' }];
    expect(overridesFromForm(form, defaults)).toEqual({
      hero: { headline: 'Changed' },
      pricing: { includes: ['A', 'C'] },
      testimonials: { items: [{ quote: 'Great', name: 'Ada', role: '' }] },
    });
  });

  it('a blank text field means "use the default"; a blank optional field means "hide it"', () => {
    const form = formFromContent(defaults);
    form.hero.headline = '';
    form.contact.whatsapp = '';
    form.pricing.setupAmount = '';
    expect(overridesFromForm(form, defaults)).toEqual({ contact: { whatsapp: '' }, pricing: { setupAmount: '' } });
  });

  it('a blank optional field that is already blank by default saves nothing', () => {
    const form = formFromContent(defaults);
    form.video.src = '';
    expect(overridesFromForm(form, defaults)).toEqual({});
  });
});
