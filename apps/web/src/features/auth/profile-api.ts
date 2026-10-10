import { userSchema } from '@frequencia/shared';
import { api } from '../../lib/http';
import { useAuthStore } from './auth-store';

/** Changes to the signed-in user's own profile; the store follows the server's answer. */
export const profileApi = {
  setAvatar: async (image: Blob) => {
    const user = await api('PUT', '/users/@me/avatar', {
      body: new Blob([image], { type: 'application/octet-stream' }),
      schema: userSchema,
    });
    useAuthStore.setState({ user });
  },
  clearAvatar: async () => {
    const user = await api('DELETE', '/users/@me/avatar', { schema: userSchema });
    useAuthStore.setState({ user });
  },
};
