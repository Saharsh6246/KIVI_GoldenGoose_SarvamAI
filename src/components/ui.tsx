'use client';
import { useState } from 'react';

export function Section({ title, hint, children, right }: { title: string; hint?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.09em] text-muted">{title}</h2>
        {hint && <p className="text-[12px] text-muted/80">{hint}</p>}
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </section>
  );
}

export function Note({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'good' | 'warn' }) {
  const c =
    tone === 'good'
      ? 'border-good/30 bg-good/5 text-good'
      : tone === 'warn'
        ? 'border-warn/30 bg-warn/5 text-warn'
        : 'border-edge bg-sand/40 text-muted';
  return <div className={`rounded-md border px-3 py-2 text-[12.5px] leading-relaxed ${c}`}>{children}</div>;
}

export function Disclosure({ label, count, children, defaultOpen = false }: { label: string; count?: number; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 text-[12px] text-muted transition hover:text-ink">
        <span className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>›</span>
        {label}
        {count != null && <span className="font-mono text-[11px] text-muted/70">{count}</span>}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="card px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-0.5 text-[19px] font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

export function fmt(ts: number, withDate = true) {
  const d = new Date(ts + 330 * 60000);
  return withDate ? `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}` : d.toISOString().slice(11, 16);
}
