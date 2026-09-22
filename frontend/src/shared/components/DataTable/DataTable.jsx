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
 * @param {import('react').ReactNode} [emptyAction]                 Shown only while empty, inside the card. See `footer` for an action that should stay visible regardless of row count.
 * @param {import('react').ReactNode} [footer]                      Rendered inside the SAME bordered card as the table, below it — in both the empty and non-empty states, unlike `emptyAction`/`toolbar`. Used for an action (e.g. "add the first/next row") that must stay visually contained within this table's own card rather than sitting as a sibling element after it, where it could be mistaken for belonging to whatever renders next. Doubles as the empty-state action when `emptyAction` isn't given.
 * @param {string} [errorMessage]
 * @param {string} [title]
 * @param {(row: object) => string} [rowClassName]                  Optional extra class for a row's own `<tr>` — e.g. a caller-defined "selected" look. Purely a passthrough: this component defines no selection styling of its own, per its own "presentation only" governance — the class and its rule live in the caller's own CSS module.
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
  footer,
  errorMessage,
  title,
  rowClassName,
}) {
  return (
    <Card
      title={title}
      state={state === 'success' && rows.length === 0 ? 'empty' : state}
      emptyMessage={emptyMessage ?? 'Nothing here yet.'}
      emptyAction={emptyAction ?? footer}
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
              <tr key={rowKey(row)} className={rowClassName ? rowClassName(row) : undefined}>
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
      {footer && <div className={styles.footer}>{footer}</div>}
    </Card>
  );
}
