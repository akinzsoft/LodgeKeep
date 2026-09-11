import { useState } from 'react';
import { Card, Button } from '../../shared/components/index.js';
import { migrationApi, ApiError } from '../../shared/api/index.js';
import { triggerDownload } from '../../shared/download.js';
import formStyles from './MigrationForm.module.css';

/** PRODUCT_REQUIREMENTS.md §3.20: "Import template download — one per entity ... so the client's spreadsheet arrives in a shape the parser expects." Header-only CSV, no data rows — see `backend/src/modules/migration/templates.js`. */
const ENTITY_LABELS = {
  guests: 'Guest profiles',
  reservations: 'Reservations (historical & future)',
  companies: 'Company / travel-agent profiles',
  ar_balances: 'Outstanding AR balances',
};

export function TemplatesTab() {
  const [downloadingType, setDownloadingType] = useState(null);
  const [error, setError] = useState(null);

  async function handleDownload(entityType) {
    setDownloadingType(entityType);
    setError(null);
    try {
      const blob = await migrationApi.downloadTemplate(entityType);
      triggerDownload(blob, `${entityType}-import-template.csv`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not download this template.');
    } finally {
      setDownloadingType(null);
    }
  }

  return (
    <Card title="Import templates">
      <p className={formStyles.hint}>
        Download the column template for the entity you&apos;re importing before preparing your spreadsheet — a template-driven import avoids the
        ambiguous manual mapping that is where migrations most often go wrong.
      </p>
      {error && (
        <p role="alert" className={formStyles.errorBanner}>
          {error}
        </p>
      )}
      <div className={formStyles.actionsRow}>
        {migrationApi.listEntityTypes().map((entityType) => (
          <Button
            key={entityType}
            type="button"
            variant="secondary"
            loading={downloadingType === entityType}
            onClick={() => handleDownload(entityType)}
          >
            {ENTITY_LABELS[entityType] ?? entityType}
          </Button>
        ))}
      </div>
    </Card>
  );
}
