// /terms and /privacy: short plain pages, linked from the footer.
import { copy, fill } from '../copy.ts';

export function LegalPage({ kind }: { kind: 'terms' | 'privacy' }) {
  const title = kind === 'terms' ? copy.legal.termsTitle : copy.legal.privacyTitle;
  const body = kind === 'terms' ? copy.legal.termsBody : copy.legal.privacyBody;
  return (
    <div className="page docs legal" data-testid={'legal-' + kind}>
      <h1 className="page-title">{title}</h1>
      <ul className="legal-list">
        {body.map((l) => (
          <li key={l}>{fill(l)}</li>
        ))}
      </ul>
    </div>
  );
}
