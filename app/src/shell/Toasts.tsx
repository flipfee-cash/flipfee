import { copy } from '../copy.ts';
import { dismissToast, ui } from '../state/ui.ts';
import { IconCheck, IconClose, IconWarn } from './Icons.tsx';

/** Toasts float under the top bar (above the phone's bottom bar on phones); cash toasts are green. */
export function Toasts() {
  const toasts = ui.use((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast toast-' + t.kind} data-testid="toast" data-kind={t.kind}>
          <span className="toast-ic">{t.kind === 'warn' ? <IconWarn size={17} /> : t.kind === 'cash' ? <b>$</b> : <IconCheck size={17} />}</span>
          <span className="toast-t">
            <b>{t.title}</b>
            {t.detail && <span>{t.detail}</span>}
          </span>
          {t.action && (
            <button
              type="button"
              className="toast-a"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-x" aria-label={copy.a11y.close} onClick={() => dismissToast(t.id)}>
            <IconClose size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
