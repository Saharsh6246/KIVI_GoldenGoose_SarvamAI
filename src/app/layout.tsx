import './globals.css';
import type { Metadata } from 'next';
import Nav from '@/components/Nav';

export const metadata: Metadata = {
  title: 'Kivi — semantic memory',
  description: 'Kivi remembers what you said, not who you are.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <Nav />
        <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-6">{children}</main>
      </body>
    </html>
  );
}
