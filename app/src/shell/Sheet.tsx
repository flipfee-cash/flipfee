// A sheet: a centered panel on wide screens, a bottom sheet on phones (drag the grip down to close). Stays mounted for
// the exit motion. Escape closes; focus moves in and comes back. (Adapted from peek-sol.)
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { copy } from '../copy.ts';
import { PHONE, reducedMotion, useMedia } from '../state/store.ts';
import { IconClose } from './Icons.tsx';

export function Sheet({ open, onClose, label, children, testid, size = 'md', className }: { open: boolean; onClose: () => void; label: string; children: ReactNode; testid?: string; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const [shown, setShown] = useState(open);
  const [closing, setClosing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);
  const phone = useMedia(PHONE);
  const drag = useRef({ y0: 0, dy: 0, on: false, t0: 0 });

  useEffect(() => {
    if (open) {
      back.current = document.activeElement;
      setShown(true);
      setClosing(false);
      return;
    }
    if (!shown) return;
    setClosing(true);
    const t = window.setTimeout(
      () => {
        setShown(false);
        setClosing(false);
        const el = back.current as HTMLElement | null;
        if (el && el.isConnected && typeof el.focus === 'function') el.focus({ preventScroll: true });
      },
      reducedMotion() ? 10 : 200,
    );
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', on);
    const t = window.setTimeout(() => box.current?.focus({ preventScroll: true }), 30);
    document.documentElement.classList.add('sheet-open');
    return () => {
      window.removeEventListener('keydown', on);
      window.clearTimeout(t);
      document.documentElement.classList.remove('sheet-open');
    };
  }, [open, onClose]);

  if (!shown) return null;

  const onGripDown = (e: React.PointerEvent) => {
    if (!phone) return;
    drag.current = { y0: e.clientY, dy: 0, on: true, t0: performance.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onGripMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.on || !box.current) return;
    d.dy = Math.max(0, e.clientY - d.y0);
    box.current.style.transform = `translateY(${d.dy}px)`;
  };
  const onGripUp = () => {
    const d = drag.current;
    if (!d.on || !box.current) return;
    d.on = false;
    const v = d.dy / Math.max(1, performance.now() - d.t0);
    box.current.style.transform = '';
    if (d.dy > 110 || v > 0.6) onClose();
  };

  return (
    <div className={'scrim' + (closing ? ' is-closing' : '')} onClick={onClose} data-testid={testid ? testid + '-scrim' : undefined}>
      <div
        ref={box}
        className={'sheet sheet-' + size + (closing ? ' is-closing' : '') + (className ? ' ' + className : '')}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        data-testid={testid}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp} aria-hidden="true">
          <i />
        </div>
        <button type="button" className="icon-btn sheet-x" aria-label={copy.a11y.close} onClick={onClose} data-testid="sheet-close">
          <IconClose size={18} />
        </button>
        {children}
      </div>
    </div>
  );
}
