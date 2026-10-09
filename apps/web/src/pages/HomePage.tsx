import { APP_NAME } from '@frequencia/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchApiHealth, fetchMediaHealth, type ServiceHealth } from '../lib/api';
import { cx } from '../lib/cx';

function ServiceRow({
  name,
  query,
}: {
  name: string;
  query: { data?: ServiceHealth; isError: boolean; isPending: boolean };
}) {
  const online = Boolean(query.data);
  const state = query.isPending ? 'VERIFICANDO' : online ? 'ONLINE' : 'OFFLINE';
  return (
    <li className="label flex items-center justify-between border-b border-line px-4 py-3">
      <span className="text-fg">{name}</span>
      <span className="flex items-center gap-4 text-muted">
        {query.data?.workers !== undefined && <span>{query.data.workers} WORKERS</span>}
        <span className={cx(online && 'text-accent', query.isError && 'text-danger')}>{state}</span>
      </span>
    </li>
  );
}

const labs = [{ to: '/lab/p2p', code: 'LAB.01', title: 'P2P 1:1' }];

export function HomePage() {
  const api = useQuery({
    queryKey: ['health', 'api'],
    queryFn: ({ signal }) => fetchApiHealth(signal),
    refetchInterval: 5000,
  });
  const media = useQuery({
    queryKey: ['health', 'media'],
    queryFn: ({ signal }) => fetchMediaHealth(signal),
    refetchInterval: 5000,
  });

  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-md border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">00. SISTEMA</p>
          <h1 className="display mt-1 text-2xl text-fg">{APP_NAME}</h1>
        </header>
        <ul>
          <ServiceRow name="API" query={api} />
          <ServiceRow name="MÍDIA" query={media} />
        </ul>
        <nav aria-label="Laboratório">
          <ul>
            {labs.map((lab) => (
              <li key={lab.to}>
                <Link
                  to={lab.to}
                  className="label flex items-center justify-between px-4 py-3 text-fg transition-colors hover:bg-surface-2 hover:text-accent"
                >
                  <span>
                    <span className="text-muted">{lab.code}</span> {lab.title}
                  </span>
                  <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </section>
    </main>
  );
}
