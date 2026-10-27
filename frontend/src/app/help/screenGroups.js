/**
 * "How to use each screen": the work areas the guides are grouped under. A guide's
 * folder under `content/screens/` names its group, so adding a guide is only adding a
 * file there. The order here is the order on the Help page, and a group with no guides
 * is not shown.
 */
import { listGuides } from './guides.js';

export const SCREEN_GROUPS = [
  { folder: 'front-desk', label: 'Front desk' },
  { folder: 'cashiering-and-money', label: 'Cashiering and money' },
  { folder: 'restaurant-and-bar', label: 'Restaurant and bar' },
  { folder: 'supermarket', label: 'Supermarket' },
  { folder: 'stock', label: 'Stock' },
  { folder: 'back-office-and-admin', label: 'Back office and Admin' },
];

/** @returns {{folder: string, label: string, guides: object[]}[]} only the groups that have guides */
export function listScreenGuideGroups() {
  const all = listGuides('screens');
  return SCREEN_GROUPS.map((group) => ({ ...group, guides: all.filter((guide) => guide.slug.startsWith(`screens/${group.folder}/`)) })).filter((group) => group.guides.length > 0);
}
