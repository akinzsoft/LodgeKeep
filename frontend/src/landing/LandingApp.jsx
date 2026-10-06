import { useEffect } from 'react';
import { content as defaultContent } from './landingContent.js';
import { useLandingContent } from './useLandingContent.js';
import { Header, Hero, FindCompany, TrustStrip, Features, Payments, Gallery, VideoSection, Testimonials, Pricing, Contact, Footer } from './sections.jsx';
import styles from './Landing.module.css';

/**
 * The marketing landing page — rendered ONLY at the exact bare app domain's
 * `/` (see `selectEntryTree.js`), never on a tenant subdomain. A public page:
 * it holds no session and loads no third-party script, so it needs no
 * `<AuthProvider>`. Its one API call is the public, tenant-free
 * `GET /public/landing-content`: the platform console's saved text, plus the live
 * monthly fee and trial length. If that fails the built-in defaults in
 * `landingContent.js` are shown, so the page never depends on the API.
 * The "Start free trial" buttons go to the existing `/signup`; "Sign in" sends a
 * customer to their own address.
 */
export default function LandingApp() {
  const { content, ready } = useLandingContent(defaultContent);

  useEffect(() => {
    document.title = content.pageTitle;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'description');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', content.pageDescription);
  }, [content]);

  if (!ready) {
    return (
      <div className={styles.root}>
        <Header content={content} />
        <div className={styles.loading} role="status" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <a className={styles.skipLink} href="#main">Skip to the content</a>
      <Header content={content} />
      <main id="main">
        <Hero content={content} />
        <TrustStrip content={content} />
        <Features content={content} />
        <Payments content={content} />
        <Gallery content={content} />
        <VideoSection content={content} />
        <Testimonials content={content} />
        <Pricing content={content} />
        <section className={styles.signInBand} aria-label="Sign in">
          <div className={`${styles.container} ${styles.narrow}`}>
            <FindCompany content={content} />
          </div>
        </section>
        <Contact content={content} />
      </main>
      <Footer content={content} />
    </div>
  );
}
