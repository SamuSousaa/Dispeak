import type { ReactNode } from 'react';
import { ContextMenuHost } from './ContextMenu';
import { Link } from 'react-router-dom';
import { cx } from '../lib/cx';

interface LabLayoutProps {
  code: string;
  title: string;
  status?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}

/** Frame shared by the lab routes: header strip, main area, system footer. */
export function LabLayout({ code, title, status, footer, children }: LabLayoutProps) {
  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/lab"
            className="label whitespace-nowrap text-muted transition-colors hover:text-accent"
          >
            ← LAB
          </Link>
          <span className="label text-muted" aria-hidden="true">
            /
          </span>
          <h1 className="label-lg truncate text-fg">
            <span className="text-muted">{code}</span> {title}
          </h1>
        </div>
        {status && <div className="label shrink-0 text-muted">{status}</div>}
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <ContextMenuHost />
      {footer && (
        <footer className="label flex min-h-8 shrink-0 flex-wrap items-center gap-x-6 gap-y-1 border-t border-line bg-surface px-4 py-1.5 text-muted">
          {footer}
        </footer>
      )}
    </div>
  );
}

export function Metric({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <span className={cx('whitespace-nowrap', className)}>
      {label} <span className="text-fg">{value}</span>
    </span>
  );
}
