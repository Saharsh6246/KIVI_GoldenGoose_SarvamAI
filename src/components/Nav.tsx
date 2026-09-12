'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/', label: 'Dictate', hint: 'ordinary use' },
  { href: '/ask', label: 'Hey Kivi', hint: 'ask it something' },
  { href: '/memory', label: 'Memory', hint: 'what it knows, and why' },
  { href: '/evaluation', label: 'Evaluation', hint: 'the evidence' },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-edge bg-paper/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-6 px-5 py-3">
        <Link href="/" className="flex items-baseline gap-2">
          <span className="text-[17px] font-semibold tracking-tight">kivi</span>
          <span className="hidden text-[11px] text-muted sm:inline">remembers what you said</span>
        </Link>
        <nav className="ml-auto flex items-center gap-1">
          {TABS.map((t) => {
            const active = t.href === '/' ? path === '/' : path.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                title={t.hint}
                className={`rounded-md px-3 py-1.5 text-[13px] transition ${
                  active ? 'bg-ink text-paper' : 'text-muted hover:bg-sand hover:text-ink'
                }`}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
