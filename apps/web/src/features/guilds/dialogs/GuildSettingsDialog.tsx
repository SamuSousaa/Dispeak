import {
  canManageRole,
  hasPermission,
  outranks,
  parsePermissions,
  Permissions,
  GUILD_SOUND_EVENTS,
  GUILD_SOUND_MAX_BYTES,
  type Guild,
  type GuildSoundEvent,
  type HierarchyActor,
  type Role,
} from '@frequencia/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Dialog, Field, FormError } from '../../../components/Dialog';
import { cx } from '../../../lib/cx';
import { describeError } from '../../../lib/http';
import { guildApi, inviteLink } from '../guild-api';
import { SOUND_LABELS } from '../../sounds/sound-events';
import { playSound } from '../../sounds/sound-player';
import { PERMISSION_INFO } from '../permission-labels';
import { actorIn } from '../permissions';

export type GuildSettingsTab = 'overview' | 'roles' | 'members' | 'invites' | 'sounds';
type Tab = GuildSettingsTab;

interface TabProps {
  guild: Guild;
  userId: string;
  actor: HierarchyActor;
  /** Runs a request, surfacing failures in the dialog. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 p-4">
      <h3 className="label text-muted">{title}</h3>
      {children}
    </section>
  );
}

function OverviewTab({ guild, actor, run, busy, onClose }: TabProps) {
  const navigate = useNavigate();
  const [name, setName] = useState(guild.name);
  const [confirm, setConfirm] = useState(false);
  const canRename = hasPermission(actor.permissions, Permissions.ManageGuild);

  const rename = (event: FormEvent) => {
    event.preventDefault();
    void run(() => guildApi.rename(guild.id, name.trim()));
  };
  const exit = async (action: () => Promise<unknown>) => {
    if (await run(action)) {
      navigate('/app');
      onClose();
    }
  };

  return (
    <div className="divide-y divide-line">
      {canRename && (
        <form onSubmit={rename} className="flex flex-col gap-3 p-4">
          <Field label="NOME DO SERVIDOR">
            <input
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              minLength={2}
              maxLength={48}
              required
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={busy || name.trim() === guild.name}>
              SALVAR
            </Button>
          </div>
        </form>
      )}
      <Section title="ZONA DE PERIGO">
        {confirm ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="label text-danger">
              {actor.isOwner ? 'EXCLUIR O SERVIDOR E TUDO NELE?' : 'SAIR DESTE SERVIDOR?'}
            </span>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() =>
                void exit(() =>
                  actor.isOwner ? guildApi.delete(guild.id) : guildApi.leave(guild.id),
                )
              }
            >
              CONFIRMAR
            </Button>
            <Button onClick={() => setConfirm(false)}>CANCELAR</Button>
          </div>
        ) : (
          <div>
            <Button variant="danger" onClick={() => setConfirm(true)}>
              {actor.isOwner ? 'EXCLUIR SERVIDOR' : 'SAIR DO SERVIDOR'}
            </Button>
          </div>
        )}
      </Section>
    </div>
  );
}

function RoleEditor({ role, guild, actor, run, busy }: TabProps & { role: Role }) {
  const isEveryone = role.id === guild.id;
  const [name, setName] = useState(role.name);
  const permissions = parsePermissions(role.permissions);

  const toggle = (bit: bigint) => {
    void run(() => guildApi.updateRole(role.id, { permissions: (permissions ^ bit).toString() }));
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4">
      {!isEveryone && (
        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => guildApi.updateRole(role.id, { name: name.trim() }));
          }}
        >
          <div className="min-w-0 flex-1">
            <Field label="NOME DO CARGO">
              <input
                className="field"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={32}
                required
              />
            </Field>
          </div>
          <Button type="submit" disabled={busy || name.trim() === role.name}>
            RENOMEAR
          </Button>
        </form>
      )}
      <ul className="border border-line">
        {PERMISSION_INFO.map((info) => {
          const granted = hasPermission(permissions, info.bit);
          // A member can only flip permissions they hold themselves.
          const allowed = actor.isOwner || hasPermission(actor.permissions, info.bit);
          return (
            <li key={info.name} className="border-b border-line last:border-b-0">
              <label
                className={cx(
                  'flex items-start gap-3 px-3 py-2',
                  allowed ? 'cursor-pointer hover:bg-surface-2' : 'opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  className="mt-1 h-3.5 w-3.5 shrink-0 accent-(--accent)"
                  checked={granted}
                  disabled={busy || !allowed}
                  onChange={() => toggle(info.bit)}
                />
                <span className="min-w-0">
                  <span className="label-lg block text-fg">{info.label}</span>
                  <span className="block text-xs text-muted">{info.description}</span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      {!isEveryone && (
        <div>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => void run(() => guildApi.deleteRole(role.id))}
          >
            EXCLUIR CARGO
          </Button>
        </div>
      )}
    </div>
  );
}

function RolesTab(props: TabProps) {
  const { guild, actor, run, busy } = props;
  const [selectedId, setSelectedId] = useState<string>(guild.id);
  const [newName, setNewName] = useState('');
  const roles = [...guild.roles].sort((a, b) => b.position - a.position);
  const ranked = roles.filter((role) => role.id !== guild.id);
  const selected = roles.find((role) => role.id === selectedId) ?? roles.at(-1);
  const manageable = (role: Role) =>
    canManageRole(actor, { position: role.position, isEveryone: role.id === guild.id });

  const move = (role: Role, direction: -1 | 1) => {
    const order = ranked.map((entry) => entry.id);
    const index = order.indexOf(role.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target] as string, order[index] as string];
    void run(() => guildApi.reorderRoles(guild.id, order));
  };

  return (
    <div className="flex flex-col md:flex-row">
      <div className="flex shrink-0 flex-col border-b border-line md:w-64 md:border-r md:border-b-0">
        <p className="label px-3 pt-3 pb-1 text-muted">HIERARQUIA (MAIOR PRIMEIRO)</p>
        <ul>
          {roles.map((role, index) => (
            <li key={role.id} className="flex items-center">
              <button
                type="button"
                onClick={() => setSelectedId(role.id)}
                aria-current={selected?.id === role.id}
                className={cx(
                  'label-lg min-w-0 flex-1 truncate border-l-2 px-3 py-1.5 text-left transition-colors',
                  selected?.id === role.id
                    ? 'border-accent bg-surface-2 text-accent'
                    : 'border-transparent text-fg hover:bg-surface-2',
                )}
              >
                {role.name}
              </button>
              {role.id !== guild.id && manageable(role) && (
                <span className="flex shrink-0">
                  <button
                    type="button"
                    className="label px-1.5 text-muted transition-colors hover:text-accent disabled:opacity-30"
                    aria-label={`Subir ${role.name}`}
                    disabled={busy || index === 0}
                    onClick={() => move(role, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="label px-1.5 text-muted transition-colors hover:text-accent disabled:opacity-30"
                    aria-label={`Descer ${role.name}`}
                    disabled={busy || index >= ranked.length - 1}
                    onClick={() => move(role, 1)}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2 border-t border-line p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const role = await guildApi.createRole(guild.id, newName.trim());
              setSelectedId(role.id);
              setNewName('');
            });
          }}
        >
          <input
            className="field"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="novo cargo"
            aria-label="Nome do novo cargo"
            maxLength={32}
            required
          />
          <Button type="submit" variant="primary" disabled={busy}>
            +
          </Button>
        </form>
      </div>
      {selected &&
        (manageable(selected) ? (
          <RoleEditor key={selected.id} {...props} role={selected} />
        ) : (
          <p className="label p-4 text-muted">
            ESTE CARGO ESTÁ NO SEU NÍVEL OU ACIMA; VOCÊ NÃO PODE EDITÁ-LO.
          </p>
        ))}
    </div>
  );
}

function MembersTab({ guild, userId, actor, run, busy }: TabProps) {
  const ranked = guild.roles
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);
  const canAssign = hasPermission(actor.permissions, Permissions.ManageRoles);
  const canKick = hasPermission(actor.permissions, Permissions.KickMembers);

  return (
    <ul className="divide-y divide-line">
      {guild.members.map((member) => {
        const target = actorIn(guild, member.user.id);
        const isSelf = member.user.id === userId;
        const toggleRole = (role: Role) => {
          const roleIds = member.roleIds.includes(role.id)
            ? member.roleIds.filter((id) => id !== role.id)
            : [...member.roleIds, role.id];
          void run(() => guildApi.updateMember(guild.id, member.user.id, { roleIds }));
        };
        return (
          <li
            key={member.user.id}
            className="flex flex-col gap-2 p-4"
            data-testid="settings-member"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="label-lg truncate text-fg">
                  {member.nickname ?? member.user.displayName}
                  {target.isOwner && <span className="text-muted"> · DONO</span>}
                  {isSelf && <span className="text-muted"> · VOCÊ</span>}
                </p>
                <p className="label truncate text-muted">@{member.user.username}</p>
              </div>
              {canKick && !isSelf && outranks(actor, target) && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void run(() => guildApi.kick(guild.id, member.user.id))}
                >
                  EXPULSAR
                </Button>
              )}
            </div>
            {ranked.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {ranked.map((role) => {
                  const has = member.roleIds.includes(role.id);
                  const editable =
                    canAssign &&
                    canManageRole(actor, { position: role.position, isEveryone: false });
                  if (!has && !editable) return null;
                  return (
                    <button
                      key={role.id}
                      type="button"
                      aria-pressed={has}
                      disabled={busy || !editable}
                      onClick={() => toggleRole(role)}
                      className={cx(
                        'label border px-2 py-0.5 transition-colors disabled:cursor-default',
                        has ? 'border-accent text-accent' : 'border-line-strong text-muted',
                        editable && 'hover:border-accent hover:text-fg',
                      )}
                    >
                      {role.name}
                    </button>
                  );
                })}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function SoundRow({ guild, event, run, busy }: TabProps & { event: GuildSoundEvent }) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const sound = guild.sounds[event];

  const choose = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > GUILD_SOUND_MAX_BYTES) {
      setProblem('O ARQUIVO PODE TER ATÉ 2 MB.');
      return;
    }
    setProblem(null);
    if (!(await run(() => guildApi.setSound(guild.id, event, file)))) {
      setProblem('USE UM ÁUDIO MP3, WAV, OGG, FLAC, M4A OU WEBM.');
    }
  };

  return (
    <li className="flex flex-col gap-1.5 border-b border-line pb-3 last:border-b-0 last:pb-0">
      <p className="text-sm text-fg">{SOUND_LABELS[event]}</p>
      <p className="label truncate text-muted" data-testid={`guild-sound-${event}`}>
        {sound ? `ARQUIVO: ${sound.filename}` : 'SOM PADRÃO'}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <input
          ref={input}
          type="file"
          accept="audio/*"
          hidden
          data-testid={`guild-sound-input-${event}`}
          onChange={(change) => {
            void choose(change.target.files?.[0]);
            change.target.value = '';
          }}
        />
        <Button
          aria-label={`Testar som: ${SOUND_LABELS[event]}`}
          onClick={() => void playSound(event, guild.id)}
        >
          TESTAR
        </Button>
        <Button
          disabled={busy}
          aria-label={`Escolher arquivo para: ${SOUND_LABELS[event]}`}
          onClick={() => input.current?.click()}
        >
          ESCOLHER ARQUIVO
        </Button>
        {sound && (
          <Button
            variant="danger"
            disabled={busy}
            aria-label={`Voltar ao som padrão: ${SOUND_LABELS[event]}`}
            onClick={() => void run(() => guildApi.clearSound(guild.id, event))}
          >
            PADRÃO
          </Button>
        )}
      </div>
      {problem && (
        <p role="alert" className="label text-danger">
          {problem}
        </p>
      )}
    </li>
  );
}

/** Owner only: the notification sounds everyone in the guild hears. */
function SoundsTab(props: TabProps) {
  return (
    <Section title="SONS DO SERVIDOR">
      <p className="text-sm text-muted">
        O som que você escolher aqui toca para todos os membros deste servidor, no lugar do som
        padrão e dos sons pessoais de cada um. Só o dono pode alterar. Arquivos de áudio de até 2
        MB.
      </p>
      <ul className="flex flex-col gap-3">
        {GUILD_SOUND_EVENTS.map((event) => (
          <SoundRow key={event} {...props} event={event} />
        ))}
      </ul>
    </Section>
  );
}

function InvitesTab({ guild, run, busy }: TabProps) {
  const queryClient = useQueryClient();
  const queryKey = ['invites', guild.id];
  const invites = useQuery({ queryKey, queryFn: () => guildApi.listInvites(guild.id) });

  if (invites.isPending) return <p className="label p-4 text-muted">CARREGANDO</p>;
  if (invites.isError)
    return <p className="label p-4 text-danger">{describeError(invites.error)}</p>;
  if (invites.data.length === 0)
    return <p className="label p-4 text-muted">NENHUM CONVITE ATIVO</p>;

  return (
    <ul className="divide-y divide-line">
      {invites.data.map((invite) => (
        <li key={invite.code} className="flex items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="label-lg truncate text-fg normal-case">{inviteLink(invite.code)}</p>
            <p className="label text-muted">
              {invite.uses}
              {invite.maxUses ? `/${invite.maxUses}` : ''} USOS ·{' '}
              {invite.expiresAt
                ? `EXPIRA ${new Date(invite.expiresAt).toLocaleString('pt-BR')}`
                : 'NÃO EXPIRA'}
            </p>
          </div>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await guildApi.deleteInvite(invite.code);
                await queryClient.invalidateQueries({ queryKey });
              })
            }
          >
            REVOGAR
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Server settings: overview, roles and permissions, members, invites. */
export function GuildSettingsDialog({
  guild,
  userId,
  onClose,
  initialTab = 'overview',
}: {
  guild: Guild;
  userId: string;
  onClose: () => void;
  initialTab?: GuildSettingsTab;
}) {
  const actor = actorIn(guild, userId);
  const [tab, setTab] = useState<Tab>(initialTab);
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

  const tabs: Array<{ id: Tab; label: string; visible: boolean }> = [
    { id: 'overview', label: 'GERAL', visible: true },
    {
      id: 'roles',
      label: 'CARGOS',
      visible: hasPermission(actor.permissions, Permissions.ManageRoles),
    },
    { id: 'members', label: 'MEMBROS', visible: true },
    {
      id: 'invites',
      label: 'CONVITES',
      visible: hasPermission(actor.permissions, Permissions.ManageGuild),
    },
    { id: 'sounds', label: 'SONS', visible: actor.isOwner },
  ];
  const props: TabProps = { guild, userId, actor, run, busy, onClose };

  return (
    <Dialog title={guild.name} eyebrow="CONFIGURAÇÕES DO SERVIDOR" onClose={onClose} wide>
      <div role="tablist" className="flex overflow-x-auto border-b border-line">
        {tabs
          .filter((entry) => entry.visible)
          .map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              onClick={() => {
                setTab(entry.id);
                setError(null);
              }}
              className={cx(
                'label shrink-0 border-b-2 px-4 py-2.5 transition-colors',
                tab === entry.id
                  ? 'border-accent text-accent'
                  : 'border-transparent text-muted hover:text-fg',
              )}
            >
              {entry.label}
            </button>
          ))}
      </div>
      {error && (
        <div className="border-b border-line px-4 py-2">
          <FormError message={error} />
        </div>
      )}
      {tab === 'overview' && <OverviewTab {...props} />}
      {tab === 'roles' && <RolesTab {...props} />}
      {tab === 'members' && <MembersTab {...props} />}
      {tab === 'invites' && <InvitesTab {...props} />}
      {tab === 'sounds' && <SoundsTab {...props} />}
    </Dialog>
  );
}
