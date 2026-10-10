import { APP_NAME, passwordSchema } from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '../components/Button';
import { Field, FormError } from '../components/Dialog';
import { ApiError, api } from '../lib/http';

/** Where a reset link leads: pick a new password, twice, and go sign in with it. */
export function ResetPasswordPage() {
  const { token = '' } = useParams();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!passwordSchema.safeParse(password).success) {
      setError('A senha precisa ter pelo menos 8 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setError('As duas senhas não são iguais.');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await api('POST', '/auth/password-reset', { body: { token, newPassword: password } });
      setDone(true);
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.status === 404
          ? 'Este link não vale mais: já foi usado ou passou de uma hora. Peça outro ao dono do servidor.'
          : 'Não foi possível trocar a senha. Tente de novo.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="grid-bg flex min-h-dvh items-center justify-center p-4">
      <section className="w-full max-w-sm border border-line bg-surface">
        <header className="border-b border-line px-4 py-5">
          <p className="label text-muted">NOVA SENHA</p>
          <h1 className="display mt-1 text-2xl text-fg">{APP_NAME}</h1>
        </header>
        {done ? (
          <div className="flex flex-col gap-4 p-4">
            <p role="status" className="text-sm text-fg">
              Senha trocada. Entre de novo com ela; as sessões abertas em outros aparelhos foram
              encerradas.
            </p>
            <Link
              to="/login"
              className="label self-start text-fg underline underline-offset-4 transition-colors hover:text-accent"
            >
              IR PARA O LOGIN
            </Link>
          </div>
        ) : (
          <form
            onSubmit={(event) => void submit(event)}
            className="flex flex-col gap-4 p-4"
            noValidate
          >
            <Field label="NOVA SENHA" hint="Pelo menos 8 caracteres.">
              <input
                className="field"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                maxLength={128}
                required
                autoFocus
              />
            </Field>
            <Field label="CONFIRMAR A NOVA SENHA">
              <input
                className="field"
                type="password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="new-password"
                maxLength={128}
                required
              />
            </Field>
            <FormError message={error} />
            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? 'AGUARDE' : 'TROCAR SENHA'}
            </Button>
          </form>
        )}
      </section>
    </main>
  );
}
