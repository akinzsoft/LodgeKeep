import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '../shared/components/index.js';
import { formatMoney } from '../shared/format/money.jsx';
import { slugify } from '../app/auth/screens/slugify.js';
import { buildTenantLoginUrl } from '../app/auth/screens/tenant-url.js';
import { CheckIcon, PaystackIcon, TerminalIcon, QrIcon, CashIcon, PlayIcon, QuoteIcon, CloseIcon } from './icons.jsx';
import { buildContactLinks } from './contactLinks.js';
import styles from './Landing.module.css';

const SIGNUP_PATH = '/signup';

/** A plain link styled as one of the shared Buttons (the landing page navigates, it never submits). */
function LinkButton({ href, variant = 'primary', external = false, children, ...rest }) {
  const className = { primary: styles.btnPrimary, light: styles.btnLight, ghost: styles.btnGhost }[variant] ?? styles.btnSecondary;
  return (
    <a className={`${styles.btn} ${className}`} href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} {...rest}>
      {children}
    </a>
  );
}

export function Header({ content }) {
  return (
    <header className={styles.header}>
      <div className={`${styles.container} ${styles.headerInner}`}>
        <a className={styles.brand} href="/" aria-label={`${content.brand} home`}>
          <span className={styles.brandMark} aria-hidden="true">L</span>
          <span className={styles.brandName}>{content.brand}</span>
        </a>
        <nav className={styles.nav} aria-label="Sections">
          <a className={styles.navLink} href="#features">Features</a>
          <a className={styles.navLink} href="#pricing">Pricing</a>
          <a className={styles.navLink} href="#contact">Contact</a>
        </nav>
        <div className={styles.headerActions}>
          <a className={styles.signInLink} href="#sign-in">Sign in</a>
          <LinkButton href={SIGNUP_PATH}>{content.hero.primaryCta}</LinkButton>
        </div>
      </div>
    </header>
  );
}

/**
 * "Already a customer?" — a tenant signs in at its OWN address, so the bare
 * domain asks for the company's address and sends them there. Pure
 * navigation: nothing is sent to the server, and the bare domain never shows
 * a login of its own.
 */
export function FindCompany({ content, navigate = (url) => window.location.assign(url) }) {
  const inputId = useId();
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const copy = content.signIn;

  function handleSubmit(event) {
    event.preventDefault();
    const slug = slugify(value);
    if (!slug || slug.length < 2) {
      setError(copy.invalid);
      return;
    }
    const url = buildTenantLoginUrl(slug);
    if (url) navigate(url);
  }

  return (
    <form className={styles.findCompany} id="sign-in" onSubmit={handleSubmit} noValidate>
      <h2 className={styles.findTitle}>{copy.title}</h2>
      <p className={styles.findLead}>{copy.lead}</p>
      <label className={styles.findLabel} htmlFor={inputId}>{copy.label}</label>
      <div className={styles.findRow}>
        <input
          id={inputId}
          className={styles.findInput}
          value={value}
          placeholder={copy.placeholder}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-invalid={error ? 'true' : 'false'}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
        <Button type="submit" variant="secondary">{copy.button}</Button>
      </div>
      {error && (
        <p className={styles.findError} id={`${inputId}-error`} role="alert">{error}</p>
      )}
    </form>
  );
}

export function Hero({ content }) {
  const { hero } = content;
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={`${styles.container} ${styles.heroInner}`}>
        <div className={styles.heroCopy}>
          <p className={styles.kicker}>{hero.kicker}</p>
          <h1 className={styles.heroTitle} id="hero-title">{hero.headline}</h1>
          <p className={styles.heroSub}>{hero.subhead}</p>
          <div className={styles.heroCtas}>
            <LinkButton href={SIGNUP_PATH} variant="light">{hero.primaryCta}</LinkButton>
            <LinkButton href="#contact" variant="ghost">{hero.secondaryCta}</LinkButton>
          </div>
          <p className={styles.reassurance}>{hero.reassurance}</p>
        </div>
        <figure className={styles.heroFigure}>
          <img className={styles.heroImage} src={hero.image} alt={hero.imageAlt} width="1470" height="690" />
        </figure>
      </div>
    </section>
  );
}

export function TrustStrip({ content }) {
  return (
    <section className={styles.trust} aria-label={content.trust.label}>
      <div className={styles.container}>
        <p className={styles.trustLabel}>{content.trust.label}</p>
        <ul className={styles.trustList}>
          {content.trust.items.map((item) => (
            <li key={item} className={styles.trustChip}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Features({ content }) {
  return (
    <section className={styles.section} id="features" aria-label="Features">
      <div className={styles.container}>
        {content.features.map((feature, index) => (
          <article key={feature.id} className={`${styles.featureRow} ${index % 2 === 1 ? styles.reverse : ''}`}>
            <div className={styles.featureCopy}>
              <h2 className={styles.h2}>{feature.title}</h2>
              <p className={styles.lead}>{feature.lead}</p>
              <ul className={styles.checkList}>
                {feature.points.map((point) => (
                  <li key={point}>
                    <CheckIcon className={styles.checkIcon} />
                    <span>{point}</span>
                  </li>
                ))}
              </ul>
            </div>
            <figure className={styles.shot}>
              <img src={feature.image} alt={feature.imageAlt} width="1470" height="690" loading="lazy" decoding="async" />
            </figure>
          </article>
        ))}
      </div>
    </section>
  );
}

const PAYMENT_ICONS = { paystack: PaystackIcon, terminal: TerminalIcon, nqr: QrIcon, cash: CashIcon };

export function Payments({ content }) {
  const { payments } = content;
  return (
    <section className={`${styles.section} ${styles.tinted}`} aria-labelledby="payments-title">
      <div className={styles.container}>
        <h2 className={`${styles.h2} ${styles.center}`} id="payments-title">{payments.title}</h2>
        <p className={`${styles.lead} ${styles.center}`}>{payments.lead}</p>
        <ul className={styles.cardGrid}>
          {payments.methods.map((method) => {
            const Icon = PAYMENT_ICONS[method.id] ?? PaystackIcon;
            return (
              <li key={method.id} className={styles.card}>
                <span className={styles.cardIcon}><Icon /></span>
                <h3 className={styles.h3}>{method.title}</h3>
                <p className={styles.cardText}>{method.text}</p>
              </li>
            );
          })}
        </ul>
        <p className={`${styles.note} ${styles.center}`}>{payments.note}</p>
      </div>
    </section>
  );
}

/** Tap a thumbnail to see the screenshot full size; Escape, the backdrop or Close dismisses it. */
export function Gallery({ content }) {
  const { gallery } = content;
  const [open, setOpen] = useState(null);
  const closeRef = useRef(null);
  const openerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    closeRef.current?.focus();
    function onKey(event) {
      if (event.key === 'Escape') setOpen(null);
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openerRef.current?.focus();
    };
  }, [open]);

  return (
    <section className={styles.section} aria-labelledby="gallery-title">
      <div className={styles.container}>
        <h2 className={`${styles.h2} ${styles.center}`} id="gallery-title">{gallery.title}</h2>
        <p className={`${styles.lead} ${styles.center}`}>{gallery.lead}</p>
        <ul className={styles.gallery}>
          {gallery.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={styles.thumb}
                onClick={(event) => {
                  openerRef.current = event.currentTarget;
                  setOpen(item);
                }}
                aria-label={`Enlarge: ${item.caption}`}
              >
                <img src={item.image} alt={item.alt} width="1470" height="690" loading="lazy" decoding="async" />
                <span className={styles.thumbCaption}>{item.caption}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open && (
        <div className={styles.lightbox} role="presentation" onClick={() => setOpen(null)}>
          <div className={styles.lightboxDialog} role="dialog" aria-modal="true" aria-label={open.caption} onClick={(event) => event.stopPropagation()}>
            <button type="button" ref={closeRef} className={styles.lightboxClose} onClick={() => setOpen(null)} aria-label="Close">
              <CloseIcon />
            </button>
            <img src={open.image} alt={open.alt} width="1470" height="690" />
            <p className={styles.lightboxCaption}>{open.caption}</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function VideoSection({ content }) {
  const { video } = content;
  return (
    <section className={`${styles.section} ${styles.tinted}`} aria-labelledby="video-title">
      <div className={`${styles.container} ${styles.narrow}`}>
        <h2 className={`${styles.h2} ${styles.center}`} id="video-title">{video.title}</h2>
        <p className={`${styles.lead} ${styles.center}`}>{video.lead}</p>
        {video.src ? (
          <video className={styles.video} controls preload="none" poster={video.poster || undefined} playsInline>
            <source src={video.src} type="video/mp4" />
            Your browser cannot play this video.
          </video>
        ) : (
          <div className={styles.videoPlaceholder} role="img" aria-label={video.placeholderText}>
            <PlayIcon className={styles.playIcon} />
            <p>{video.placeholderText}</p>
          </div>
        )}
      </div>
    </section>
  );
}

export function Testimonials({ content }) {
  const { testimonials } = content;
  const items = testimonials.items.length > 0 ? testimonials.items : [{ ...testimonials.placeholder, placeholder: true }];
  return (
    <section className={styles.section} aria-labelledby="testimonials-title">
      <div className={styles.container}>
        <h2 className={`${styles.h2} ${styles.center}`} id="testimonials-title">{testimonials.title}</h2>
        <ul className={styles.cardGrid}>
          {items.map((item) => (
            <li key={`${item.name}-${item.quote.slice(0, 12)}`} className={`${styles.card} ${item.placeholder ? styles.placeholderCard : ''}`}>
              <QuoteIcon className={styles.quoteIcon} />
              <blockquote className={styles.quote}>{item.quote}</blockquote>
              <p className={styles.quoteBy}>
                <strong>{item.name}</strong>
                <span>{item.role}</span>
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Pricing({ content }) {
  const { pricing } = content;
  return (
    <section className={`${styles.section} ${styles.tinted}`} id="pricing" aria-labelledby="pricing-title">
      <div className={`${styles.container} ${styles.narrow}`}>
        <h2 className={`${styles.h2} ${styles.center}`} id="pricing-title">{pricing.title}</h2>
        <p className={`${styles.lead} ${styles.center}`}>{pricing.lead}</p>
        <div className={styles.priceCard}>
          <p className={styles.planName}>{pricing.planName}</p>
          {pricing.setupAmount && (
            <p className={styles.setupFee}>
              <span className="tabular-nums">{formatMoney(pricing.setupAmount, pricing.currency)}</span> {pricing.setupLabel}
            </p>
          )}
          <p className={styles.price}>
            <span className={`${styles.priceAmount} tabular-nums`}>{formatMoney(pricing.amount, pricing.currency)}</span>
            <span className={styles.priceInterval}>{pricing.interval}</span>
          </p>
          <p className={styles.trial}>{pricing.trial}</p>
          <ul className={styles.checkList}>
            {pricing.includes.map((point) => (
              <li key={point}>
                <CheckIcon className={styles.checkIcon} />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <LinkButton href={SIGNUP_PATH}>{pricing.cta}</LinkButton>
        </div>
      </div>
    </section>
  );
}

export function Contact({ content }) {
  const { contact } = content;
  const links = buildContactLinks(contact);
  return (
    <section className={styles.contact} id="contact" aria-labelledby="contact-title">
      <div className={`${styles.container} ${styles.narrow} ${styles.center}`}>
        <h2 className={`${styles.h2} ${styles.onDark}`} id="contact-title">{contact.title}</h2>
        <p className={`${styles.lead} ${styles.onDark}`}>{contact.lead}</p>
        {links.length > 0 ? (
          <div className={styles.contactButtons}>
            {links.map((link) => (
              <LinkButton key={link.id} href={link.href} external={link.external} variant="light">{link.label}</LinkButton>
            ))}
          </div>
        ) : (
          <p className={styles.contactEmpty}>{contact.emptyNotice}</p>
        )}
      </div>
    </section>
  );
}

export function Footer({ content }) {
  const year = new Date().getFullYear();
  return (
    <footer className={styles.footer}>
      <div className={`${styles.container} ${styles.footerInner}`}>
        <div>
          <p className={styles.footerBrand}>{content.brand}</p>
          <p className={styles.footerText}>{content.footer.blurb}</p>
        </div>
        <ul className={styles.footerLinks}>
          <li><a className={styles.footerLink} href={SIGNUP_PATH}>Start free trial</a></li>
          <li><a className={styles.footerLink} href="#sign-in">Sign in</a></li>
          <li><a className={styles.footerLink} href="#features">Features</a></li>
          <li><a className={styles.footerLink} href="#pricing">Pricing</a></li>
          <li><a className={styles.footerLink} href="#contact">Contact</a></li>
          <li><a className={styles.footerLink} href={content.companyUrl} target="_blank" rel="noopener noreferrer">{content.company}</a></li>
        </ul>
        <p className={styles.copyright}>&copy; {year} {content.company}. All rights reserved.</p>
      </div>
    </footer>
  );
}
