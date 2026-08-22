'use client';

import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import Link from 'next/link';
import { useLinkComponent } from '@astryxdesign/core/Link';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Theme theme={neutralTheme} mode="dark">
      {children}
    </Theme>
  );
}
