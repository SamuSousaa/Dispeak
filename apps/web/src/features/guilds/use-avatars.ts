import { useMemo } from 'react';
import { useGatewayStore } from '../gateway/gateway-store';

/**
 * Looks up the profile picture of anyone the user shares a server with. For places that only
 * know a user id, such as the participants of a voice channel.
 */
export function useAvatars(): (userId: string) => string | null {
  const guilds = useGatewayStore((state) => state.guilds);
  return useMemo(() => {
    const pictures = new Map<string, string | null>();
    for (const guild of Object.values(guilds)) {
      for (const member of guild.members) pictures.set(member.user.id, member.user.avatar);
    }
    return (userId: string) => pictures.get(userId) ?? null;
  }, [guilds]);
}
