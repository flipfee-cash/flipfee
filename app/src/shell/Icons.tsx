// Line icons: 24px grid, 1.8 stroke, square-ish caps (board hardware). Decorative unless a label is passed.
import type { ReactNode } from 'react';

function Svg({ children, size = 20, label, className }: { children: ReactNode; size?: number; label?: string; className?: string }) {
  return (
    <svg
      className={'ic' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {children}
    </svg>
  );
}

type P = { size?: number; label?: string; className?: string };

export const IconClose = (p: P) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
    <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
  </Svg>
);
export const IconExternal = (p: P) => (
  <Svg {...p}>
    <path d="M14 5h5v5M19 5l-8 8" />
    <path d="M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H11" />
  </Svg>
);
export const IconCheck = (p: P) => (
  <Svg {...p}>
    <path d="m5 12.5 4.2 4.2L19 7" />
  </Svg>
);
export const IconSound = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" />
    <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
  </Svg>
);
export const IconSoundOff = (p: P) => (
  <Svg {...p}>
    <path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z" />
    <path d="m16 9.5 5 5M21 9.5l-5 5" />
  </Svg>
);
export const IconShare = (p: P) => (
  <Svg {...p}>
    <path d="M12 4v11M7.5 8.5 12 4l4.5 4.5" />
    <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
  </Svg>
);
export const IconArrowLeft = (p: P) => (
  <Svg {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
);
export const IconArrowRight = (p: P) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M9 5.5v13M15 5.5v13" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M7.5 5.5v13l11-6.5z" />
  </Svg>
);
export const IconHand = (p: P) => (
  <Svg {...p}>
    <path d="M8 12.5V6.8a1.5 1.5 0 0 1 3 0V11M11 10.5V5.3a1.5 1.5 0 0 1 3 0V11M14 10.8V6.8a1.5 1.5 0 0 1 3 0v6.4c0 4-2.6 6.8-6.3 6.8-2.6 0-4-1.2-5.4-3.4l-2-3.2a1.4 1.4 0 0 1 2.3-1.6L8 13.5" />
  </Svg>
);
export const IconWarn = (p: P) => (
  <Svg {...p}>
    <path d="M12 4 3 19.5h18z" />
    <path d="M12 10v4.5M12 17.2v.1" />
  </Svg>
);
export const IconBolt = (p: P) => (
  <Svg {...p}>
    <path d="M13 3 5.5 13.5H12L11 21l7.5-10.5H12z" />
  </Svg>
);

/** Phantom's mark (the ghost) for the connect buttons: Phantom is the only wallet. */
export function PhantomGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg className="phantom-glyph" width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="#AB9FF2" />
      <path
        d="M9.5 27.4V18.6C9.5 12.8 14.2 8.5 20 8.5s10.5 4.3 10.5 10.1v8.8c0 1.7-2 2.5-3.2 1.3l-1.5-1.6a2 2 0 0 0-2.9 0l-1.4 1.5a2 2 0 0 1-2.9 0L17.2 27.1a2 2 0 0 0-2.9 0L12.7 28.7c-1.2 1.2-3.2.4-3.2-1.3Z"
        fill="#FFFDF8"
      />
      <ellipse cx="16.6" cy="18.4" rx="1.7" ry="2.4" fill="#3C315B" />
      <ellipse cx="23.4" cy="18.4" rx="1.7" ry="2.4" fill="#3C315B" />
    </svg>
  );
}
