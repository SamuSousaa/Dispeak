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
import { Dialog, Field, FormError, useCloseDialog } from '../../../components/Dialog';
import { SettingsSection, SettingsShell, type ShellPage } from '../../../components/SettingsShell';
import { cx } from '../../../lib/cx';
import { describeError } from '../../../lib/http';
import { isAllowedIn, isPrivate, setAllowedIn, setPrivate } from '../channel-privacy';
import { guildApi } from '../guild-api';
import { PERMISSION_GROUPS, PERMISSION_INFO } from '../permission-labels';
import { channelPermissions, memberName } from '../permissions';

type Tri = 'allow' | 'inherit' | 'deny';
type Page = 'overview' | 'permissions' | 'delete';

const triLabel: Record<Tri, string> = { allow: 'PERMITIR', inherit: 'HERDAR', deny: 'NEGAR' };

function stateOf(overwrite: Overwrite | undefined, bit: bigint): Tri {
  if (!overwrite) return 'inherit';
  if (hasPermission(parsePermissions(overwrite.allow), bit)) return 'allow';
  if (hasPermission(parsePermissions(overwrite.deny), bit)) return 'deny';
  return 'inherit';
}

/** Runs one change at a time, keeping its error on screen. */
function useAction() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (failure) {
      setError(describeError(failure));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run };
}

interface ChannelPageProps {
  guild: Guild;
  channel: Channel;
  userId: string;
  /** "canal", "categoria" or "tópico". */
  kind: string;
}

/** Name and topic, saved together; leaving the page with changes keeps them for later. */
function Overview({ channel, kind }: ChannelPageProps) {
  const isThread = channel.type === 'thread';
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [saved, setSaved] = useState(false);
  const { error, busy, run } = useAction();
  const changed =
    name.trim() !== channel.name || (topic.trim() || null) !== (channel.topic ?? null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(() =>
      guildApi.updateChannel(
        channel.id,
        isThread ? { name: name.trim() } : { name: name.trim(), topic: topic.trim() || null },
      ),
    ).then((ok) => setSaved(ok));
  };
  const undo = () => {
    setName(channel.name);
    setTopic(channel.topic ?? '');
  };

  return (
    <form onSubmit={save} className="flex min-h-full flex-col">
      <SettingsSection number="01" title={`SOBRE O ${kind.toUpperCase()}`}>
        <Field label="NOME">
          <input
            className="field"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setSaved(false);
            }}
            maxLength={48}
            required
          />
        </Field>
        {channel.type !== 'category' && !isThread && (
          <Field label="ASSUNTO" hint="Aparece no topo do canal, ao lado do nome.">
            <input
              className="field"
              value={topic}
              onChange={(event) => {
                setTopic(event.target.value);
                setSaved(false);
              }}
              maxLength={256}
            />
          </Field>
        )}
        <FormError message={error} />
        {saved && !changed && (
          <p role="status" className="label text-muted">
            SALVO
          </p>
        )}
      </SettingsSection>
      {/* Like Discord: changes wait at the bottom until saved or undone. */}
      {changed && (
        <div
          className="anim-rise sticky bottom-0 mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line-strong bg-surface-2 px-4 py-3 sm:px-6"
          data-testid="unsaved-changes"
        >
          <span className="label text-fg">ALTERAÇÕES NÃO SALVAS</span>
          <span className="flex gap-2">
            <Button onClick={undo} disabled={busy}>
              DESFAZER
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              SALVAR
            </Button>
          </span>
        </div>
      )}
    </form>
  );
}

/** Who sees the channel at all: everyone, or only the roles and people picked. */
function Privacy({ guild, channel, userId, kind }: ChannelPageProps) {
  const { error, busy, run } = useAction();
  const hidden = isPrivate(guild, channel);
  const targets = [
    ...guild.roles
      .filter((role) => role.id !== guild.id)
      .map((role) => ({ id: role.id, label: role.name, color: role.color })),
    ...guild.members
      .filter((member) => member.user.id !== guild.ownerId)
      .map((member) => ({
        id: member.user.id,
        label: `@${memberName(guild, member.user.id)}`,
        color: null,
      })),
  ];
  return (
    <div className="flex flex-col gap-3" data-testid="privacy">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-(--accent)"
          checked={hidden}
          disabled={busy}
          onChange={(event) =>
            void run(() => setPrivate(guild, channel, userId, event.target.checked))
          }
        />
        <span className="flex min-w-0 flex-col">
          <span className="label text-fg">
            {kind === 'categoria' ? 'CATEGORIA PRIVADA' : 'CANAL PRIVADO'}
          </span>
          <span className="text-xs text-muted">
            Some da lista para todo mundo, menos para o dono, os administradores e quem você marcar
            abaixo.
          </span>
        </span>
      </label>
      {hidden && (
        <div className="flex flex-col gap-2">
          <p className="label text-muted">QUEM PODE VER</p>
          <div className="flex flex-wrap gap-1.5">
            {targets.map((target) => {
              const allowed = isAllowedIn(channel, target.id);
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={allowed}
                  disabled={busy}
                  onClick={() => void run(() => setAllowedIn(guild, channel, target.id, !allowed))}
                  style={allowed && target.color ? { color: target.color } : undefined}
                  className={cx(
                    'label border px-2 py-0.5 transition-colors hover:border-accent',
                    allowed ? 'border-accent text-accent' : 'border-line-strong text-muted',
                  )}
                >
                  {target.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/**
 * Exceptions to the server's roles in this channel, Discord-like: the roles and members that
 * have one on the left (and a way to add another), the permissions of the chosen one on the
 * right, grouped, each allowed, denied or left to the role.
 */
function Overwrites({ guild, channel }: ChannelPageProps) {
  const { error, busy, run } = useAction();
  const [targetId, setTargetId] = useState(guild.id);
  const roleIds = new Set(guild.roles.map((role) => role.id));
  const overwritten = new Set(channel.overwrites.map((entry) => entry.targetId));
  const nameOf = (id: string) =>
    id === guild.id
      ? '@everyone'
      : roleIds.has(id)
        ? (guild.roles.find((role) => role.id === id)?.name ?? 'Cargo')
        : `@${memberName(guild, id)}`;
  // Listed: everyone, whoever has an exception, and the one being edited.
  const listed = [
    guild.id,
    ...guild.roles.map((role) => role.id).filter((id) => id !== guild.id && overwritten.has(id)),
    ...guild.members.map((member) => member.user.id).filter((id) => overwritten.has(id)),
  ];
  if (!listed.includes(targetId)) listed.push(targetId);
  const addable = [
    ...guild.roles.filter((role) => !listed.includes(role.id)).map((role) => role.id),
    ...guild.members.map((member) => member.user.id).filter((id) => !listed.includes(id)),
  ];

  const overwrite = channel.overwrites.find((entry) => entry.targetId === targetId);
  const relevant = PERMISSION_INFO.filter((info) => info.channels.includes(channel.type));
  const groups = PERMISSION_GROUPS.map((group) => ({
    title: group.title,
    entries: relevant.filter((info) => group.names.includes(info.name)),
  })).filter((group) => group.entries.length > 0);

  const setPermission = (bit: bigint, next: Tri) => {
    let allow = parsePermissions(overwrite?.allow ?? '0') & ~bit;
    let deny = parsePermissions(overwrite?.deny ?? '0') & ~bit;
    if (next === 'allow') allow |= bit;
    if (next === 'deny') deny |= bit;
    void run(() =>
      allow === 0n && deny === 0n
        ? guildApi.deleteOverwrite(channel.id, targetId)
        : guildApi.putOverwrite(channel.id, targetId, {
            targetType: roleIds.has(targetId) ? 'role' : 'member',
            allow: allow.toString(),
            deny: deny.toString(),
          }),
    );
  };

  return (
    <div className="grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        <p className="label text-muted">CARGOS E MEMBROS</p>
        <ul className="border border-line" aria-label="Cargos e membros com exceções">
          {listed.map((id) => (
            <li key={id}>
              <button
                type="button"
                aria-pressed={id === targetId}
                onClick={() => setTargetId(id)}
                className={cx(
                  'label flex w-full items-center justify-between gap-2 border-l-2 px-3 py-1.5 text-left transition-colors',
                  id === targetId
                    ? 'border-accent bg-surface-2 text-accent'
                    : 'border-transparent text-fg hover:text-accent',
                )}
              >
                <span className="truncate">{nameOf(id)}</span>
                {overwritten.has(id) && <span className="shrink-0 text-muted">EXCEÇÃO</span>}
              </button>
            </li>
          ))}
        </ul>
        {addable.length > 0 && (
          <select
            className="field"
            aria-label="Adicionar cargo ou membro"
            value=""
            onChange={(event) => event.target.value && setTargetId(event.target.value)}
          >
            <option value="">+ ADICIONAR</option>
            {addable.map((id) => (
              <option key={id} value={id}>
                {nameOf(id)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="flex min-w-0 flex-col gap-4">
        <p className="text-xs text-muted">
          Exceções de <span className="text-fg">{nameOf(targetId)}</span> neste canal. HERDAR usa o
          que o cargo já permite no servidor.
        </p>
        {groups.map((group) => (
          <div key={group.title} className="flex flex-col gap-1.5">
            <p className="label text-muted">{group.title}</p>
            <ul className="border border-line">
              {group.entries.map((info) => {
                const current = stateOf(overwrite, info.bit);
                return (
                  <li
                    key={info.name}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
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
                      {(['deny', 'inherit', 'allow'] as const).map((value) => (
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
          </div>
        ))}
        <FormError message={error} />
      </div>
    </div>
  );
}

function Delete({ channel, kind }: ChannelPageProps) {
  const close = useCloseDialog();
  const { error, busy, run } = useAction();
  return (
    <SettingsSection number="01" title={`EXCLUIR ${kind.toUpperCase()}`}>
      <p className="text-sm text-muted">
        {kind === 'categoria'
          ? 'Os canais da categoria continuam existindo, soltos na lista.'
          : 'As mensagens, os anexos e as permissões deste canal somem para todos. Não dá para desfazer.'}
      </p>
      <Button
        variant="danger"
        className="self-start"
        disabled={busy}
        onClick={() =>
          void run(() => guildApi.deleteChannel(channel.id)).then((ok) => ok && close())
        }
      >
        SIM, EXCLUIR {channel.name.toUpperCase()}
      </Button>
      <FormError message={error} />
    </SettingsSection>
  );
}

/** Settings of one channel: what it is called, who sees it, what each role may do in it. */
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
  const isThread = channel.type === 'thread';
  // A thread follows its channel: there is nothing to configure about who gets in.
  const canEditPermissions = !isThread && hasPermission(permissions, Permissions.ManageRoles);
  const kind = channel.type === 'category' ? 'categoria' : isThread ? 'tópico' : 'canal';

  const pages: Array<ShellPage<Page>> = [
    ...(canEdit
      ? [{ id: 'overview' as const, label: 'VISÃO GERAL', group: kind.toUpperCase() }]
      : []),
    ...(canEditPermissions
      ? [{ id: 'permissions' as const, label: 'PERMISSÕES', group: kind.toUpperCase() }]
      : []),
    ...(canEdit
      ? [{ id: 'delete' as const, label: `EXCLUIR ${kind.toUpperCase()}`, group: '', danger: true }]
      : []),
  ];
  const [page, setPage] = useState<Page>(pages[0]?.id ?? 'overview');
  const props = { guild, channel, userId, kind };
  const prefix = channel.type === 'text' || channel.type === 'thread' ? '#' : '';

  return (
    <Dialog settings title={`Configurar ${kind} ${channel.name}`} onClose={onClose}>
      <SettingsShell
        title={`${prefix}${channel.name}`.toUpperCase()}
        pages={pages}
        page={page}
        onPage={setPage}
      >
        {page === 'overview' && <Overview {...props} />}
        {page === 'permissions' && (
          <>
            <SettingsSection number="01" title="PRIVACIDADE">
              <Privacy {...props} />
            </SettingsSection>
            <SettingsSection number="02" title={`PERMISSÕES NESTE ${kind.toUpperCase()}`} wide>
              <Overwrites {...props} />
            </SettingsSection>
          </>
        )}
        {page === 'delete' && <Delete {...props} />}
      </SettingsShell>
    </Dialog>
  );
}
