import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { FormError } from '../components/Dialog';
import { guildApi } from '../features/guilds/guild-api';
import { describeError } from '../lib/http';

/** Landing page of an invite link: shows where it leads and lets the user join. */
export function InvitePage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const preview = useQuery({
    queryKey: ['invite', code],
    queryFn: () => guildApi.previewInvite(code),
    retry: false,
  });

  const accept = async () => {
    setJoining(true);
    setError(null);
    try {
      const guild = await guildApi.acceptInvite(code);
      navigate(`/app/${guild.id}`, { replace: true });
    } catch (failure) {
      setError(describeError(failure));
      setJoining(false);
    }
  };

  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-sm border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">CONVITE / {code}</p>
          <h1 className="display mt-1 text-2xl text-fg">
            {preview.data?.guild.name ?? (preview.isError ? 'CONVITE INVÁLIDO' : '…')}
          </h1>
        </header>
        <div className="flex flex-col gap-4 p-4">
          {preview.isError && <p className="text-sm text-muted">{describeError(preview.error)}</p>}
          {preview.data && (
            <>
              <p className="label text-muted">
                {preview.data.guild.memberCount}{' '}
                {preview.data.guild.memberCount === 1 ? 'MEMBRO' : 'MEMBROS'}
              </p>
              <FormError message={error} />
              {preview.data.alreadyMember ? (
                <Button
                  variant="primary"
                  onClick={() => navigate(`/app/${preview.data.guild.id}`, { replace: true })}
                >
                  ABRIR SERVIDOR
                </Button>
              ) : (
                <Button variant="primary" onClick={accept} disabled={joining}>
                  {joining ? 'ENTRANDO' : 'ACEITAR CONVITE'}
                </Button>
              )}
            </>
          )}
          <Link to="/app" className="label text-muted transition-colors hover:text-accent">
            ← VOLTAR
          </Link>
        </div>
      </section>
    </main>
  );
}
