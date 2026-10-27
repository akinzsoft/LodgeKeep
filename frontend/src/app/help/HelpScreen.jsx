import { useState } from 'react';
import { Card } from '../../shared/components/index.js';
import { GuideMedia } from './GuideMedia.jsx';
import { Markdown } from './markdown.jsx';
import { getGuide, listGuides } from './guides.js';
import { STEPS } from './gettingStarted.js';
import { listScreenGuideGroups } from './screenGroups.js';
import { useGettingStartedProgress } from './useGettingStartedProgress.js';
import styles from './HelpScreen.module.css';

const STATUS_TEXT = {
  done: 'Ticked automatically from your setup',
  unknown: 'We cannot check this one for you; tick it yourself when done',
  todo: 'Not done yet',
  manual: 'Tick it yourself when done',
};

/**
 * Help and Training. The Getting started checklist ticks steps from existing
 * read-only data where it can and otherwise keeps manual ticks in this
 * browser only (no server state). Guides are markdown files in `content/`.
 */
export function HelpScreen({ activeProperty, currentUserId }) {
  const [openSlug, setOpenSlug] = useState(null);
  const { steps, doneCount, total, next, complete, loading, toggle } = useGettingStartedProgress({
    userId: currentUserId,
    propertyId: activeProperty?.id,
  });
  const guide = openSlug ? getGuide(openSlug) : null;
  const stepForGuide = STEPS.findIndex((step) => step.guide === openSlug);
  const problemGuides = listGuides('common-problems');
  const screenGroups = listScreenGuideGroups();

  if (guide) {
    return (
      <div className={styles.page}>
        <button type="button" className={styles.back} onClick={() => setOpenSlug(null)}>
          ← Back to Help
        </button>
        <article className={styles.article}>
          {stepForGuide >= 0 && <p className={styles.stepLabel}>Step {stepForGuide + 1} of {STEPS.length}</p>}
          <div className={styles.articleBody}>
            <div className={styles.text}>
              <Markdown source={guide.source} onOpenGuide={setOpenSlug} />
            </div>
            <GuideMedia video={guide.video} videoTitle={guide.videoTitle} images={guide.images} />
          </div>
          {stepForGuide >= 0 && (
            <nav className={styles.stepNav} aria-label="Getting started steps">
              {stepForGuide > 0 && (
                <button type="button" onClick={() => setOpenSlug(STEPS[stepForGuide - 1].guide)}>
                  ← Previous step
                </button>
              )}
              {stepForGuide < STEPS.length - 1 && (
                <button type="button" onClick={() => setOpenSlug(STEPS[stepForGuide + 1].guide)}>
                  Next step →
                </button>
              )}
            </nav>
          )}
        </article>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Help and Training</h1>

      <Card title="Getting started">
        <p className={styles.summary} aria-live="polite">
          {loading ? 'Checking your setup…' : `${doneCount} of ${total} steps done`}
          {complete && ' — you are ready to trade.'}
        </p>
        <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount} aria-label="Getting started progress">
          <div className={styles.barFill} style={{ width: `${(doneCount / total) * 100}%` }} />
        </div>
        {next && !complete && (
          <p className={styles.next}>
            Next: <button type="button" className={styles.link} onClick={() => setOpenSlug(next.guide)}>{next.title}</button>
          </p>
        )}
        <ol className={styles.checklist}>
          {steps.map((step) => (
            <li key={step.id} className={styles.item}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={step.done}
                  disabled={step.auto === 'done'}
                  onChange={() => toggle(step.id)}
                  aria-label={`${step.title} — ${STATUS_TEXT[step.auto]}`}
                />
              </label>
              <div>
                <button type="button" className={styles.link} onClick={() => setOpenSlug(step.guide)}>
                  {step.title}
                </button>
                <p className={styles.hint}>{step.done ? (step.auto === 'done' ? STATUS_TEXT.done : 'Ticked by you') : STATUS_TEXT[step.auto]}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      {screenGroups.length > 0 && (
        <Card title="How to use each screen">
          {screenGroups.map((group) => (
            <section key={group.folder} aria-labelledby={`screens-${group.folder}`}>
              <h3 id={`screens-${group.folder}`} className={styles.groupTitle}>{group.label}</h3>
              <ul className={styles.guideList}>
                {group.guides.map((item) => (
                  <li key={item.slug}>
                    <button type="button" className={styles.link} onClick={() => setOpenSlug(item.slug)}>
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </Card>
      )}

      <Card title="Common problems">
        <ul className={styles.guideList}>
          {problemGuides.map((item) => (
            <li key={item.slug}>
              <button type="button" className={styles.link} onClick={() => setOpenSlug(item.slug)}>
                {item.title}
              </button>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
