import { NavLink } from 'react-router-dom';
import { contextMenu } from '../../components/ContextMenu';
import { cx } from '../../lib/cx';
import { useGatewayStore } from '../gateway/gateway-store';
import { markGuildRead, sumUnread, useUnreadStore } from '../unread/unread-store';

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0] ?? '';
  const second = words[1] ?? '';
  return (second ? `${first[0] ?? ''}${second[0] ?? ''}` : first.slice(0, 2)).toUpperCase();
}

/** Leftmost rail: one square per server, plus the button to create or join one. */
export function ServerRail({ onAdd }: { onAdd: () => void }) {
  const guilds = useGatewayStore((state) => state.guilds);
  const order = useGatewayStore((state) => state.guildOrder);
  const unread = useUnreadStore((state) => state.channels);

  return (
    <nav
      aria-label="Servidores"
      className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-bg py-2"
    >
      {order.map((id) => {
        const guild = guilds[id];
        if (!guild) return null;
        const pending = sumUnread(Object.values(unread).filter((entry) => entry.guildId === id));
        return (
          <NavLink
            key={id}
            to={`/app/${id}`}
            title={guild.name}
            aria-label={
              pending.mentions > 0
                ? `${guild.name}, ${pending.mentions} ${pending.mentions === 1 ? 'menção' : 'menções'}`
                : pending.count > 0
                  ? `${guild.name}, mensagens não lidas`
                  : guild.name
            }
            data-unread={pending.count > 0}
            {...contextMenu(guild.name, () => [
              pending.count > 0 && {
                label: 'Marcar tudo como lido',
                onSelect: () => markGuildRead(id),
              },
              {
                label: 'Copiar link do servidor',
                onSelect: () =>
                  void navigator.clipboard?.writeText(`${window.location.origin}/app/${id}`),
              },
            ])}
            className={({ isActive }) =>
              cx(
                'display relative flex h-10 w-10 shrink-0 items-center justify-center border text-sm transition-colors',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-line-strong text-muted hover:border-accent hover:text-fg',
              )
            }
          >
            {initials(guild.name)}
            {pending.mentions > 0 ? (
              <span className="label absolute -right-1 -bottom-1 bg-fg px-1 text-bg">
                {pending.mentions > 99 ? '99+' : pending.mentions}
              </span>
            ) : (
              pending.count > 0 && (
                <span className="absolute -right-0.5 -bottom-0.5 h-2 w-2 bg-fg" />
              )
            )}
          </NavLink>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        title="Criar ou entrar em um servidor"
        aria-label="Criar ou entrar em um servidor"
        className="label-lg flex h-10 w-10 shrink-0 items-center justify-center border border-dashed border-line-strong text-muted transition-colors hover:border-accent hover:text-accent"
      >
        +
      </button>
    </nav>
  );
}
