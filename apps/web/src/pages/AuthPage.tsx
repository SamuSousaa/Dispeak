import { APP_NAME, passwordSchema, usernameSchema } from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Dialog';
import { login, register, useAuthStore } from '../features/auth/auth-store';
import { describeError } from '../lib/http';

/** Where to go after signing in; only same-origin paths are honoured. */
function useNext(): string {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/app';
}

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const status = useAuthStore((state) => state.status);
  const next = useNext();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isRegister = mode === 'register';

  if (status === 'authenticated') return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (isRegister) {
      if (!usernameSchema.safeParse(username).success) {
        setError('Usuário: 3 a 24 caracteres, apenas letras minúsculas, números, _ e .');
        return;
      }
      if (!passwordSchema.safeParse(password).success) {
        setError('A senha precisa ter pelo menos 8 caracteres.');
        return;
      }
    }
    setError(null);
    setBusy(true);
    try {
      if (isRegister) {
        await register({ username, password, displayName: displayName.trim() || undefined });
      } else {
        await login({ username, password });
      }
    } catch (failure) {
      setError(describeError(failure, 'Não foi possível conectar. Tente de novo.'));
    } finally {
      setBusy(false);
    }
  };

  const query = next === '/app' ? '' : `?next=${encodeURIComponent(next)}`;

  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-sm border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">{isRegister ? '01. CRIAR CONTA' : '01. ENTRAR'}</p>
          <h1 className="display mt-1 text-2xl text-fg">{APP_NAME}</h1>
        </header>
        <form onSubmit={submit} className="flex flex-col gap-4 p-4" noValidate>
          <Field label="USUÁRIO">
            <input
              className="field"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={24}
              required
              autoFocus
            />
          </Field>
          {isRegister && (
            <Field label="NOME DE EXIBIÇÃO" hint="Opcional. É como os outros veem você.">
              <input
                className="field"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="nickname"
                maxLength={32}
              />
            </Field>
          )}
          <Field label="SENHA">
            <input
              className="field"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              maxLength={128}
              required
            />
          </Field>
          <FormError message={error} />
          <Button type="submit" variant="primary" disabled={busy || status === 'loading'}>
            {busy ? 'AGUARDE' : isRegister ? 'CRIAR CONTA' : 'ENTRAR'}
          </Button>
        </form>
        <footer className="label border-t border-line px-4 py-3 text-muted">
          {isRegister ? 'JÁ TEM CONTA? ' : 'AINDA NÃO TEM CONTA? '}
          <Link
            to={`${isRegister ? '/login' : '/register'}${query}`}
            className="text-fg underline underline-offset-4 transition-colors hover:text-accent"
          >
            {isRegister ? 'ENTRAR' : 'CRIAR CONTA'}
          </Link>
        </footer>
      </section>
    </main>
  );
}
