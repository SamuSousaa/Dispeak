import { NavLink } from 'react-router-dom';
import { cx } from '../../lib/cx';
import { useGatewayStore } from '../gateway/gateway-store';

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

  return (
    <nav
      aria-label="Servidores"
      className="flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto border-r border-line bg-bg py-2"
    >
      {order.map((id) => {
        const guild = guilds[id];
        if (!guild) return null;
        return (
          <NavLink
            key={id}
            to={`/app/${id}`}
            title={guild.name}
            aria-label={guild.name}
            className={({ isActive }) =>
              cx(
                'display flex h-10 w-10 shrink-0 items-center justify-center border text-sm transition-colors',
                isActive
                  ? 'border-accent text-accent'
                  : 'border-line-strong text-muted hover:border-accent hover:text-fg',
              )
            }
          >
            {initials(guild.name)}
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
