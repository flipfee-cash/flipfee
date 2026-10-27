// A home section's one-line title: a plain statement of what the section shows, with its key words
// in ink. Words between *stars* in the copy are the key words; they dither in when the title first scrolls into view,
// and a dithered underline drifts under them.
import { useEffect, useRef } from 'react';
import { fill } from '../copy.ts';

export function SectionTitle({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) {
        el.classList.add('is-in');
        io.disconnect();
      }
    }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <h2 ref={ref} id={id} className="stitle">
      {fill(text).split('*').map((part, i) => (i % 2 ? <em key={i} className="acc">{part}</em> : part))}
    </h2>
  );
}
