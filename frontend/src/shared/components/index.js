/**
 * The shared component set — PLAN.md Phase 0: "card, KPI card, status pill,
 * data table, icon badge, toast, confirm dialog, skeleton." Feature modules
 * import from here, matching the same module-boundary convention the
 * backend follows (CLAUDE.md: cross-module calls go through a surface, never
 * a file reached into directly).
 * `Button` was added after Phase 0's original pass — several screens needed
 * a real filled/bordered/danger control instead of a bare `<button>`.
 */

export { Button } from './Button/Button.jsx';
export { Card } from './Card/Card.jsx';
export { KPICard } from './KPICard/KPICard.jsx';
export { StatusPill } from './StatusPill/StatusPill.jsx';
export { DataTable } from './DataTable/DataTable.jsx';
export { IconBadge } from './IconBadge/IconBadge.jsx';
export { Toast } from './Toast/Toast.jsx';
export { ConfirmDialog } from './ConfirmDialog/ConfirmDialog.jsx';
export { Skeleton } from './Skeleton/Skeleton.jsx';
