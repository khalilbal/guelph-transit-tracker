import type { Metadata } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: 'Guelph Transit Pulse',
  description: 'A mobile-first unofficial live transit tracker for Guelph built on official GTFS and GTFS-Realtime feeds.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
