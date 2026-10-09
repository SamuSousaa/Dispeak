import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Dialog, Field, FormError } from '../../../components/Dialog';
import { cx } from '../../../lib/cx';
import { describeError } from '../../../lib/http';
import { guildApi, parseInviteCode } from '../guild-api';

type Mode = 'create' | 'join';

/** Create a new server, or join an existing one with an invite. */
export function AddGuildDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const guild =
        mode === 'create'
          ? await guildApi.create(name.trim())
          : await guildApi.acceptInvite(parseInviteCode(invite));
      navigate(`/app/${guild.id}`);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Adicionar servidor" eyebrow="SERVIDORES" onClose={onClose}>
      <div role="tablist" className="flex border-b border-line">
        {(['create', 'join'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            onClick={() => {
              setMode(value);
              setError(null);
            }}
            className={cx(
              'label flex-1 border-b-2 px-4 py-2.5 transition-colors',
              mode === value
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-fg',
            )}
          >
            {value === 'create' ? 'CRIAR' : 'ENTRAR COM CONVITE'}
          </button>
        ))}
      </div>
      <form onSubmit={submit} className="flex flex-col gap-4 p-4">
        {mode === 'create' ? (
          <Field label="NOME DO SERVIDOR">
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={48}
              required
              autoFocus
            />
          </Field>
        ) : (
          <Field label="CONVITE" hint="Cole o link ou apenas o código.">
            <input
              className="field"
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              placeholder="ex.: aB3dE5gH"
              required
              autoFocus
            />
          </Field>
        )}
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'AGUARDE' : mode === 'create' ? 'CRIAR SERVIDOR' : 'ENTRAR'}
        </Button>
      </form>
    </Dialog>
  );
}
