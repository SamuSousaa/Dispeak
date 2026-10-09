import type { ChannelType, Guild } from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Dialog, Field, FormError } from '../../../components/Dialog';
import { cx } from '../../../lib/cx';
import { describeError } from '../../../lib/http';
import { guildApi } from '../guild-api';

const TYPES: Array<{ value: ChannelType; label: string; hint: string }> = [
  { value: 'text', label: 'TEXTO', hint: 'Mensagens' },
  { value: 'voice', label: 'VOZ', hint: 'Conversa e transmissão de tela' },
  { value: 'category', label: 'CATEGORIA', hint: 'Agrupa canais' },
];

export function CreateChannelDialog({
  guild,
  parentId,
  onClose,
}: {
  guild: Guild;
  parentId: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [type, setType] = useState<ChannelType>('text');
  const [name, setName] = useState('');
  const [parent, setParent] = useState(parentId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const categories = guild.channels.filter((channel) => channel.type === 'category');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const channel = await guildApi.createChannel(guild.id, {
        name: name.trim(),
        type,
        parentId: type === 'category' ? null : parent || null,
      });
      if (channel.type !== 'category') navigate(`/app/${guild.id}/${channel.id}`);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setBusy(false);
    }
  };

  return (
    <Dialog title="Criar canal" eyebrow={guild.name} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4 p-4">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="label mb-1.5 text-muted">TIPO</legend>
          <div className="grid grid-cols-3 gap-px border border-line bg-line">
            {TYPES.map((option) => (
              <label
                key={option.value}
                className={cx(
                  'flex cursor-pointer flex-col gap-0.5 bg-surface px-3 py-2 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-accent',
                  type === option.value ? 'text-accent' : 'text-fg hover:bg-surface-2',
                )}
              >
                <input
                  type="radio"
                  name="channel-type"
                  className="sr-only"
                  value={option.value}
                  checked={type === option.value}
                  onChange={() => setType(option.value)}
                />
                <span className="label">{option.label}</span>
                <span className="text-xs text-muted">{option.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="NOME">
          <input
            className="field"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={48}
            required
            autoFocus
          />
        </Field>
        {type !== 'category' && categories.length > 0 && (
          <Field label="CATEGORIA">
            <select
              className="field"
              value={parent}
              onChange={(event) => setParent(event.target.value)}
            >
              <option value="">SEM CATEGORIA</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
        )}
        <FormError message={error} />
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'AGUARDE' : 'CRIAR CANAL'}
        </Button>
      </form>
    </Dialog>
  );
}
