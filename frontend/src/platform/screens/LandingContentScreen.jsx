import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, DataTable } from '../../shared/components/index.js';
import { platformApi, ApiError } from '../../shared/api/index.js';
import { formatMoney } from '../../shared/format/money.jsx';
import { applyOverrides, formFromContent, overridesFromForm } from '../../landing/contentOverrides.js';
import { usePlatformAuth } from '../auth/PlatformAuthContext.jsx';
import styles from './PlatformScreens.module.css';

const MAX_TESTIMONIALS = 6;
const MAX_INCLUDES = 12;

function Field({ id, label, hint, children }) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      {children}
      {hint && <span className={styles.subtitle}>{hint}</span>}
    </div>
  );
}

/**
 * LandingContentScreen — edits the public marketing landing page from the
 * platform console (user-requested), so a price, contact number or piece of copy
 * changes without a code edit or a redeploy. The page applies the saved values
 * over the defaults in `landing/landingContent.js` within about a minute.
 *
 * What is editable is an allow-list (hero text, pricing wording and the setup
 * fee, the "what's included" list, contact details, testimonials, the demo
 * video). The monthly fee and the trial length are shown read-only: the page
 * quotes the real billing plan and the real trial setting, so it can never
 * promise something customers are not charged or given. Writing needs the admin
 * tier; a support account sees the screen and the server refuses the save.
 */
export function LandingContentScreen({ onBack, onLogout }) {
  const { role } = usePlatformAuth();
  const [defaults, setDefaults] = useState(null);
  const [view, setView] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [fieldIssues, setFieldIssues] = useState([]);
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = (requestRef.current += 1);
    try {
      const [{ content: baseDefaults }, result] = await Promise.all([import('../../landing/landingContent.js'), platformApi.getLandingContent()]);
      if (requestId !== requestRef.current) return;
      const live = applyOverrides(baseDefaults, { overrides: result.current?.content ?? {}, monthly: result.monthly, trialDays: result.trialDays });
      setDefaults(baseDefaults);
      setView(result);
      setForm(formFromContent(live));
      setError(null);
    } catch (caught) {
      if (requestId !== requestRef.current) return;
      setError(caught instanceof ApiError ? caught.message : 'Could not load the landing page content.');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    load();
  }, [load]);

  const set = (section, field, value) => setForm((current) => ({ ...current, [section]: { ...current[section], [field]: value } }));
  const issueFor = (path) => fieldIssues.find((issue) => issue.field === path || issue.field.startsWith(`${path}[`) || issue.field.startsWith(`${path}.`));

  async function run(action, doneMessage) {
    setSaving(true);
    setError(null);
    setFieldIssues([]);
    setNotice(null);
    try {
      await action();
      setNotice(doneMessage);
      await load();
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        setFieldIssues(Array.isArray(caught.details) ? caught.details : []);
      } else {
        setError('Could not save. Try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  const save = () => run(() => platformApi.saveLandingContent(overridesFromForm(form, defaults)), 'Saved. The landing page shows this within a minute.');

  const header = (
    <div className={styles.consoleHeader}>
      <h1 className={styles.consoleTitle}>Landing page</h1>
      <div className={styles.actionsRow}>
        <a href="/" target="_blank" rel="noopener noreferrer">
          <Button variant="secondary" type="button">
            Open the live page
          </Button>
        </a>
        <Button variant="secondary" onClick={onBack}>
          Back to tenants
        </Button>
        <Button variant="ghost" onClick={onLogout}>
          Sign out
        </Button>
      </div>
    </div>
  );

  if (!form || !view) {
    return (
      <div className={styles.console}>
        {header}
        {error ? (
          <>
            <p role="alert" className={styles.errorBanner}>
              {error}
            </p>
            <Button onClick={load}>Try again</Button>
          </>
        ) : (
          <p className={styles.hint}>Loading…</p>
        )}
      </div>
    );
  }

  const monthly = view.monthly;

  return (
    <div className={styles.console}>
      {header}
      {error && (
        <p role="alert" className={styles.errorBanner}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className={styles.hint}>
          {notice}
        </p>
      )}
      {role !== 'admin' && <p className={styles.hint}>Saving needs the platform admin tier — your account can look, but the server will refuse a save.</p>}

      <Card title="Shown from the live system (not editable here)">
        <p className={styles.liveFacts}>
          <span>
            <strong>Monthly fee:</strong> {monthly ? `${formatMoney(monthly.amount, monthly.currency)} per month` : 'No billing plan is set up'}
          </span>
          <span>
            <strong>Free trial:</strong> {view.trialDays} days
          </span>
        </p>
        <p className={styles.subtitle}>
          The page quotes the real billing plan and the real trial length, so it can never differ from what customers are charged or given.
          The hero and pricing lines about the trial are built from these.
        </p>
      </Card>

      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Card title="Hero">
          <div className={styles.form}>
            <Field id="lp-headline" label="Headline">
              <input id="lp-headline" className={styles.input} value={form.hero.headline} maxLength={120} onChange={(e) => set('hero', 'headline', e.target.value)} />
            </Field>
            <Field id="lp-subhead" label="Sub-headline">
              <textarea id="lp-subhead" className={styles.textarea} value={form.hero.subhead} maxLength={300} onChange={(e) => set('hero', 'subhead', e.target.value)} />
            </Field>
            <Field id="lp-cta1" label="Main button text">
              <input id="lp-cta1" className={styles.input} value={form.hero.primaryCta} maxLength={40} onChange={(e) => set('hero', 'primaryCta', e.target.value)} />
            </Field>
            <Field id="lp-cta2" label="Second button text">
              <input id="lp-cta2" className={styles.input} value={form.hero.secondaryCta} maxLength={40} onChange={(e) => set('hero', 'secondaryCta', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Pricing">
          <div className={styles.form}>
            <Field id="lp-ptitle" label="Section title">
              <input id="lp-ptitle" className={styles.input} value={form.pricing.title} maxLength={80} onChange={(e) => set('pricing', 'title', e.target.value)} />
            </Field>
            <Field id="lp-plead" label="Section intro">
              <input id="lp-plead" className={styles.input} value={form.pricing.lead} maxLength={200} onChange={(e) => set('pricing', 'lead', e.target.value)} />
            </Field>
            <Field id="lp-setup" label="One-time setup fee" hint="An amount like 500000. Leave empty to hide the setup fee line.">
              <input id="lp-setup" className={styles.input} inputMode="decimal" value={form.pricing.setupAmount} onChange={(e) => set('pricing', 'setupAmount', e.target.value)} />
            </Field>
            {issueFor('pricing.setupAmount') && <p role="alert" className={styles.errorBanner}>{issueFor('pricing.setupAmount').message}</p>}
            <Field id="lp-setuplabel" label="Setup fee wording">
              <input id="lp-setuplabel" className={styles.input} value={form.pricing.setupLabel} maxLength={60} onChange={(e) => set('pricing', 'setupLabel', e.target.value)} />
            </Field>
            <Field id="lp-includes" label="What's included" hint={`One per line, up to ${MAX_INCLUDES}. Only list what the app really does.`}>
              <textarea
                id="lp-includes"
                className={styles.textarea}
                rows={7}
                value={form.pricing.includes.join('\n')}
                onChange={(e) => set('pricing', 'includes', e.target.value.split('\n'))}
              />
            </Field>
            {issueFor('pricing.includes') && <p role="alert" className={styles.errorBanner}>{issueFor('pricing.includes').message}</p>}
          </div>
        </Card>

        <Card title="Contact">
          <div className={styles.form}>
            <Field id="lp-ctitle" label="Section title">
              <input id="lp-ctitle" className={styles.input} value={form.contact.title} maxLength={80} onChange={(e) => set('contact', 'title', e.target.value)} />
            </Field>
            <Field id="lp-clead" label="Section intro">
              <input id="lp-clead" className={styles.input} value={form.contact.lead} maxLength={300} onChange={(e) => set('contact', 'lead', e.target.value)} />
            </Field>
            <Field id="lp-wa" label="WhatsApp number" hint="International form, e.g. 2347031308712. Leave empty to hide the WhatsApp button.">
              <input id="lp-wa" className={styles.input} inputMode="tel" value={form.contact.whatsapp} onChange={(e) => set('contact', 'whatsapp', e.target.value)} />
            </Field>
            {issueFor('contact.whatsapp') && <p role="alert" className={styles.errorBanner}>{issueFor('contact.whatsapp').message}</p>}
            <Field id="lp-phone" label="Phone number" hint="Leave empty to hide the call button.">
              <input id="lp-phone" className={styles.input} inputMode="tel" value={form.contact.phone} onChange={(e) => set('contact', 'phone', e.target.value)} />
            </Field>
            {issueFor('contact.phone') && <p role="alert" className={styles.errorBanner}>{issueFor('contact.phone').message}</p>}
            <Field id="lp-email" label="Email" hint="Leave empty to hide the email button.">
              <input id="lp-email" className={styles.input} type="email" value={form.contact.email} onChange={(e) => set('contact', 'email', e.target.value)} />
            </Field>
            {issueFor('contact.email') && <p role="alert" className={styles.errorBanner}>{issueFor('contact.email').message}</p>}
            <Field id="lp-wamsg" label="Pre-filled WhatsApp message">
              <input id="lp-wamsg" className={styles.input} value={form.contact.whatsappMessage} maxLength={200} onChange={(e) => set('contact', 'whatsappMessage', e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card title="Testimonials">
          <div className={styles.form}>
            <p className={styles.subtitle}>With none, the page shows a labelled placeholder. Add only real customers&apos; words.</p>
            {form.testimonials.items.map((item, index) => (
              <div key={index} className={styles.itemCard}>
                <Field id={`lp-tq-${index}`} label={`Quote ${index + 1}`}>
                  <textarea
                    id={`lp-tq-${index}`}
                    className={styles.textarea}
                    value={item.quote}
                    maxLength={400}
                    onChange={(e) => set('testimonials', 'items', form.testimonials.items.map((row, i) => (i === index ? { ...row, quote: e.target.value } : row)))}
                  />
                </Field>
                <Field id={`lp-tn-${index}`} label={`Name ${index + 1}`}>
                  <input
                    id={`lp-tn-${index}`}
                    className={styles.input}
                    value={item.name}
                    maxLength={80}
                    onChange={(e) => set('testimonials', 'items', form.testimonials.items.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)))}
                  />
                </Field>
                <Field id={`lp-tr-${index}`} label={`Role ${index + 1}`}>
                  <input
                    id={`lp-tr-${index}`}
                    className={styles.input}
                    value={item.role}
                    maxLength={80}
                    onChange={(e) => set('testimonials', 'items', form.testimonials.items.map((row, i) => (i === index ? { ...row, role: e.target.value } : row)))}
                  />
                </Field>
                <div className={styles.actionsRow}>
                  <Button type="button" variant="ghost" onClick={() => set('testimonials', 'items', form.testimonials.items.filter((_, i) => i !== index))}>
                    Remove testimonial {index + 1}
                  </Button>
                </div>
              </div>
            ))}
            {issueFor('testimonials') && <p role="alert" className={styles.errorBanner}>{issueFor('testimonials').message}</p>}
            {form.testimonials.items.length < MAX_TESTIMONIALS && (
              <div className={styles.actionsRow}>
                <Button type="button" variant="secondary" onClick={() => set('testimonials', 'items', [...form.testimonials.items, { quote: '', name: '', role: '' }])}>
                  Add a testimonial
                </Button>
              </div>
            )}
          </div>
        </Card>

        <Card title="Demo video">
          <div className={styles.form}>
            <Field
              id="lp-video"
              label="Video file"
              hint="A file hosted on this site, like /lodgekeep-demo.mp4 (put the file in the app's public folder first). Other websites' videos (YouTube, Vimeo) are blocked by the page's security policy. Leave empty to show the 'coming soon' placeholder."
            >
              <input id="lp-video" className={styles.input} value={form.video.src} onChange={(e) => set('video', 'src', e.target.value)} />
            </Field>
            {issueFor('video.src') && <p role="alert" className={styles.errorBanner}>{issueFor('video.src').message}</p>}
            <Field id="lp-poster" label="Video cover image (optional)" hint="A hosted image like /lodgekeep-demo-poster.webp.">
              <input id="lp-poster" className={styles.input} value={form.video.poster} onChange={(e) => set('video', 'poster', e.target.value)} />
            </Field>
            {issueFor('video.poster') && <p role="alert" className={styles.errorBanner}>{issueFor('video.poster').message}</p>}
          </div>
        </Card>

        <div className={styles.actionsRow}>
          <Button type="submit" loading={saving}>
            Save changes
          </Button>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => setConfirm({ kind: 'reset' })}>
            Reset everything to the defaults
          </Button>
        </div>
      </form>

      <DataTable
        title="Version history"
        state={view.versions.length === 0 ? 'empty' : 'success'}
        emptyMessage="Nothing has been saved yet — the page shows its built-in defaults."
        columns={[
          { key: 'id', label: 'Version' },
          { key: 'created_at', label: 'Saved' },
          { key: 'note', label: 'What' },
          {
            key: 'actions',
            label: '',
            render: (row) =>
              row.id === view.current?.id ? (
                <span className={styles.subtitle}>Live now</span>
              ) : (
                <Button type="button" variant="secondary" size="compact" disabled={saving} onClick={() => setConfirm({ kind: 'restore', id: row.id })}>
                  Restore version {row.id}
                </Button>
              ),
          },
        ]}
        rows={view.versions}
        rowKey={(row) => row.id}
      />

      {confirm?.kind === 'reset' && (
        <ConfirmDialog
          title="Reset the landing page to its defaults?"
          consequence="Every edit made here is dropped and the page shows the text built into the app again. The history keeps your previous version so you can restore it."
          confirmLabel="Reset to defaults"
          onConfirm={() => {
            setConfirm(null);
            run(() => platformApi.resetLandingContent(), 'Reset. The landing page shows its defaults within a minute.');
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm?.kind === 'restore' && (
        <ConfirmDialog
          title={`Restore version ${confirm.id}?`}
          consequence="The landing page goes back to what that version said, within a minute. The current version stays in the history."
          confirmLabel="Restore"
          onConfirm={() => {
            const { id } = confirm;
            setConfirm(null);
            run(() => platformApi.restoreLandingContentVersion(id), `Restored version ${id}.`);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
