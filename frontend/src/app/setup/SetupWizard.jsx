import { useEffect, useState } from 'react';
import { Button } from '../../shared/components/index.js';
import { setupApi, ApiError } from '../../shared/api/index.js';
import { PropertyTab } from './PropertyTab.jsx';
import { RoomTypesTab } from './RoomTypesTab.jsx';
import { RoomsTab } from './RoomsTab.jsx';
import { RateCodesTab } from './RateCodesTab.jsx';
import { TaxesTab } from './TaxesTab.jsx';
import { UsersTab } from './UsersTab.jsx';
import styles from './SetupScreen.module.css';
import formStyles from './SetupForm.module.css';

/**
 * SetupWizard — PLAN.md Phase 1 gap closure, PRODUCT_REQUIREMENTS.md
 * §3.19: "Setup wizard — a guided first-run flow: property details → room
 * types → rooms → rate plans → taxes → users. Show progress and allow
 * resuming; nobody completes this in one sitting."
 *
 * Every step below is the SAME component `SetupScreen`'s own tab strip
 * already renders — this is a guided wrapper around that existing work,
 * not a second copy of six forms. Progress/resumability is deliberately
 * never stored: `GET /setup/progress` (src/modules/setup) recomputes
 * completion from the real data every time this mounts, the same "read the
 * real thing, don't invent a shadow state" reasoning Reporting's own
 * daily_reports snapshot already follows — leaving mid-wizard and coming
 * back simply re-derives the same answer, with nothing to persist or go
 * stale.
 *
 * `onPropertiesChanged` reloads BOTH the wizard's own progress AND
 * `SetupScreen`'s `properties` list, since creating a property in the first
 * step is the one action here that changes what `activeProperty` even is
 * for every later step.
 */
export function SetupWizard({ properties, activeProperty, onPropertiesChanged, isOffline = false }) {
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [hasAutoResumed, setHasAutoResumed] = useState(false);

  async function reloadProgress() {
    try {
      setProgress(await setupApi.getSetupProgress());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not load setup progress.');
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate fetch-on-mount; no data-fetching library exists yet to own this
    reloadProgress();
  }, []);

  useEffect(() => {
    // Resume at the first incomplete step, but only once per mount — after
    // that, the admin's own clicks through the step list are what should
    // move `stepIndex`, not every background reload.
    if (hasAutoResumed || !progress) return;
    const firstIncomplete = progress.steps.findIndex((step) => !step.complete);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resuming from freshly-loaded progress is the point of this effect
    setStepIndex(firstIncomplete === -1 ? 0 : firstIncomplete);
    setHasAutoResumed(true);
  }, [progress, hasAutoResumed]);

  async function handlePropertiesChanged() {
    await onPropertiesChanged();
    await reloadProgress();
  }

  if (progress === null) {
    return <p className={styles.loading}>Loading setup progress…</p>;
  }

  const steps = progress.steps;
  const currentStep = steps[stepIndex];
  const disabled = !activeProperty;

  return (
    <div className={styles.page}>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}

      <ol className={formStyles.row} aria-label="Setup steps">
        {steps.map((step, index) => (
          <li key={step.key}>
            <button
              type="button"
              className={formStyles.input}
              aria-current={index === stepIndex ? 'step' : undefined}
              onClick={() => setStepIndex(index)}
            >
              {step.complete ? '✓ ' : ''}
              {step.label}
              {step.optional ? ' (optional)' : ''}
            </button>
          </li>
        ))}
      </ol>

      {progress.operational ? (
        <p className={formStyles.disabledNotice} role="status">
          All required steps are complete — this property is operational. Taxes and Users are shown above for
          completeness but never block operation.
        </p>
      ) : (
        <p className={formStyles.disabledNotice} role="status">
          Not yet operational — complete Property, Room Types, Rooms, and Rate Codes to finish setup.
        </p>
      )}

      {currentStep.key === 'property' && <PropertyTab properties={properties} onPropertiesChanged={handlePropertiesChanged} />}
      {currentStep.key === 'room-types' && <RoomTypesTab activeProperty={activeProperty} disabled={disabled} />}
      {currentStep.key === 'rooms' && <RoomsTab disabled={disabled} />}
      {currentStep.key === 'rate-codes' && <RateCodesTab activeProperty={activeProperty} disabled={disabled} />}
      {currentStep.key === 'taxes' && <TaxesTab activeProperty={activeProperty} disabled={disabled} isOffline={isOffline} />}
      {currentStep.key === 'users' && <UsersTab disabled={disabled} isOffline={isOffline} />}

      <div className={formStyles.actionsRow}>
        <Button
          type="button"
          variant="secondary"
          disabled={stepIndex === 0}
          onClick={() => setStepIndex((index) => Math.max(0, index - 1))}
        >
          Back
        </Button>
        <Button
          type="button"
          disabled={stepIndex === steps.length - 1}
          onClick={async () => {
            await reloadProgress();
            setStepIndex((index) => Math.min(steps.length - 1, index + 1));
          }}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
