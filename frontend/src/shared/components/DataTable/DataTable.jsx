import { Card } from '../Card/Card.jsx';
import styles from './DataTable.module.css';

/**
 * DataTable — DESIGN_SYSTEM.md §1: "card container, sticky header,
 * --surface-sunken zebra rows or hairline separators, status as pill, row
 * actions right-aligned. Filter and search live at the top of the card."
 * Responsive breakpoints: "Tables become stacked cards on mobile rather than
 * scrolling horizontally."
 *
 * Presentation only, per this file's own governing spec ("this file governs
 * presentation, not behaviour") — `columns` describes how to RENDER a value
 * (money through `Money`, status through `StatusPill`, anything else through
 * a plain cell or a custom `render`), never how to fetch, sort, or filter
 * one. `toolbar` is a slot for whatever search/filter controls the caller's
 * own data layer needs; this component has no opinion on them beyond where
 * they sit.
 *
 * The mobile "stacked cards" transform (DESIGN_SYSTEM.md §1) is pure CSS
 * (`DataTable.module.css`'s `@media (max-width: 639px)` block, using
 * `data-label` + `::before`), not a second render path — the same DOM
 * serves both breakpoints, so there is exactly one source of truth for a
 * row's content.
 *
 * @param {Array<{key: string, label: string, align?: 'left'|'right', render?: (row: object) => import('react').ReactNode}>} columns
 * @param {object[]} rows
 * @param {(row: object) => string|number} rowKey
 * @param {(row: object) => import('react').ReactNode} [actions]   Right-aligned row actions (DESIGN_SYSTEM.md §1).
 * @param {import('react').ReactNode} [toolbar]                     Filter/search controls, rendered at the top of the card.
 * @param {'loading'|'empty'|'error'|'success'} [state]
 * @param {string} [emptyMessage]
 * @param {import('react').ReactNode} [emptyAction]
 * @param {string} [errorMessage]
 * @param {string} [title]
 */
export function DataTable({
  columns,
  rows,
  rowKey,
  actions,
  toolbar,
  state = 'success',
  emptyMessage,
  emptyAction,
  errorMessage,
  title,
}) {
  return (
    <Card
      title={title}
      state={state === 'success' && rows.length === 0 ? 'empty' : state}
      emptyMessage={emptyMessage ?? 'Nothing here yet.'}
      emptyAction={emptyAction}
      errorMessage={errorMessage}
    >
      {toolbar && <div className={styles.toolbar}>{toolbar}</div>}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={column.align === 'right' ? styles.right : ''} scope="col">
                  {column.label}
                </th>
              ))}
              {actions && (
                <th className={styles.right} scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => (
                  <td key={column.key} data-label={column.label} className={column.align === 'right' ? styles.right : ''}>
                    {column.render ? column.render(row) : row[column.key]}
                  </td>
                ))}
                {actions && (
                  <td data-label="Actions" className={styles.right}>
                    <div className={styles.actions}>{actions(row)}</div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
