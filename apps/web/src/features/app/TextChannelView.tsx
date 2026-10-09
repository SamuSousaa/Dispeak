import type { Channel } from '@frequencia/shared';

/** Main area for a text channel. */
export function TextChannelView({ channel }: { channel: Channel }) {
  return (
    <div className="grid-bg flex h-full items-center justify-center p-4">
      <p className="label text-muted">NENHUMA MENSAGEM EM {channel.name}</p>
    </div>
  );
}
