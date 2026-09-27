import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/**
 * Prints one document on its own. While mounted, the children are placed
 * directly under <body> (a portal) and the body is marked, so the print
 * stylesheet (`styles/print.css`) hides the whole app and shows only this —
 * the screen itself is unchanged, since the document is hidden on screen.
 * Mount it just for the print (then call `window.print()`), so a page never
 * carries a stale hidden copy.
 */
export function PrintDocument({ children }) {
  useEffect(() => {
    document.body.classList.add('lk-printing-document');
    return () => document.body.classList.remove('lk-printing-document');
  }, []);
  return createPortal(
    <div className="lk-print-document" data-testid="print-document">
      {children}
    </div>,
    document.body
  );
}
