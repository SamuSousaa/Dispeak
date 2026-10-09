import {
  hasPermission,
  parsePermissions,
  Permissions,
  type Channel,
  type Guild,
  type Overwrite,
} from '@frequencia/shared';
import { useState, type FormEvent } from 'react';
import { Button } from '../../../components/Button';
import { Dialog, Field, FormError } from '../../../components/Dialog';
import { cx } from '../../../lib/cx';
import { describeError } from '../../../lib/http';
import { guildApi } from '../guild-api';
import { PERMISSION_INFO } from '../permission-labels';
import { channelPermissions, memberName } from '../permissions';

type Tri = 'allow' | 'inherit' | 'deny';

const triLabel: Record<Tri, string> = { allow: 'PERMITIR', inherit: 'HERDAR', deny: 'NEGAR' };

function stateOf(overwrite: Overwrite | undefined, bit: bigint): Tri {
  if (!overwrite) return 'inherit';
  if (hasPermission(parsePermissions(overwrite.allow), bit)) return 'allow';
  if (hasPermission(parsePermissions(overwrite.deny), bit)) return 'deny';
  return 'inherit';
}

/** Name, topic and per-role/member permission overwrites of one channel. */
export function ChannelSettingsDialog({
  guild,
  channel,
  userId,
  onClose,
}: {
  guild: Guild;
  channel: Channel;
  userId: string;
  onClose: () => void;
}) {
  const permissions = channelPermissions(guild, channel, userId);
  const canEdit = hasPermission(permissions, Permissions.ManageChannels);
  const canEditPermissions = hasPermission(permissions, Permissions.ManageRoles);

  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [targetId, setTargetId] = useState(guild.id);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const run = async (action: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (closeAfter) onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      () => guildApi.updateChannel(channel.id, { name: name.trim(), topic: topic.trim() || null }),
      true,
    );
  };

  const targetIsRole = guild.roles.some((role) => role.id === targetId);
  const overwrite = channel.overwrites.find((entry) => entry.targetId === targetId);
  const relevant = PERMISSION_INFO.filter((info) => info.channels.includes(channel.type));

  const setPermission = (bit: bigint, next: Tri) => {
    let allow = parsePermissions(overwrite?.allow ?? '0') & ~bit;
    let deny = parsePermissions(overwrite?.deny ?? '0') & ~bit;
    if (next === 'allow') allow |= bit;
    if (next === 'deny') deny |= bit;
    void run(() =>
      allow === 0n && deny === 0n
        ? guildApi.deleteOverwrite(channel.id, targetId)
        : guildApi.putOverwrite(channel.id, targetId, {
            targetType: targetIsRole ? 'role' : 'member',
            allow: allow.toString(),
            deny: deny.toString(),
          }),
    );
  };

  const kind = channel.type === 'category' ? 'categoria' : 'canal';

  return (
    <Dialog
      title={channel.name}
      eyebrow={`CONFIGURAR ${kind.toUpperCase()}`}
      onClose={onClose}
      wide
    >
      <div className="flex flex-col divide-y divide-line">
        {canEdit && (
          <form onSubmit={save} className="flex flex-col gap-4 p-4">
            <Field label="NOME">
              <input
                className="field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={48}
                required
              />
            </Field>
            {channel.type !== 'category' && (
              <Field label="TÓPICO">
                <input
                  className="field"
                  value={topic}
                  onChange={(event) => setTopic(event.target.value)}
                  maxLength={256}
                />
              </Field>
            )}
            <div>
              <Button type="submit" variant="primary" disabled={busy}>
                SALVAR
              </Button>
            </div>
          </form>
        )}

        {canEditPermissions && (
          <section className="flex flex-col gap-3 p-4">
            <h3 className="label text-muted">PERMISSÕES NESTE {kind.toUpperCase()}</h3>
            <Field
              label="CARGO OU MEMBRO"
              hint="Cada permissão pode ser permitida, negada ou herdada do cargo."
            >
              <select
                className="field"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <optgroup label="CARGOS">
                  {guild.roles.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                      {channel.overwrites.some((entry) => entry.targetId === role.id) ? ' *' : ''}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="MEMBROS">
                  {guild.members.map((member) => (
                    <option key={member.user.id} value={member.user.id}>
                      {memberName(guild, member.user.id)}
                      {channel.overwrites.some((entry) => entry.targetId === member.user.id)
                        ? ' *'
                        : ''}
                    </option>
                  ))}
                </optgroup>
              </select>
            </Field>
            <ul className="border border-line">
              {relevant.map((info) => {
                const current = stateOf(overwrite, info.bit);
                return (
                  <li
                    key={info.name}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0">
                      <span className="label-lg block text-fg">{info.label}</span>
                      <span className="block text-xs text-muted">{info.description}</span>
                    </span>
                    <span
                      role="radiogroup"
                      aria-label={info.label}
                      className="flex shrink-0 border border-line-strong"
                    >
                      {(['allow', 'inherit', 'deny'] as const).map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={current === value}
                          disabled={busy}
                          onClick={() => setPermission(info.bit, value)}
                          className={cx(
                            'label border-r border-line-strong px-2 py-1 transition-colors last:border-r-0',
                            current !== value && 'text-muted hover:text-fg',
                            current === value && value === 'allow' && 'bg-accent text-on-accent',
                            current === value && value === 'deny' && 'bg-danger text-on-accent',
                            current === value && value === 'inherit' && 'bg-surface-2 text-fg',
                          )}
                        >
                          {triLabel[value]}
                        </button>
                      ))}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <div className="flex flex-col gap-3 p-4">
          <FormError message={error} />
          {canEdit &&
            (confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="label text-danger">EXCLUIR DEFINITIVAMENTE?</span>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void run(() => guildApi.deleteChannel(channel.id), true)}
                >
                  SIM, EXCLUIR
                </Button>
                <Button onClick={() => setConfirmDelete(false)}>CANCELAR</Button>
              </div>
            ) : (
              <div>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  EXCLUIR {kind.toUpperCase()}
                </Button>
              </div>
            ))}
        </div>
      </div>
    </Dialog>
  );
}
