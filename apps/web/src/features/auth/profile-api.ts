import { selfSchema, type UpdateProfileRequest } from '@frequencia/shared';
import { api } from '../../lib/http';
import { useAuthStore } from './auth-store';

const picture = (image: Blob) => new Blob([image], { type: 'application/octet-stream' });

/** Runs a profile request and keeps the signed-in user in step with the server's answer. */
async function apply(request: Promise<ReturnType<typeof selfSchema.parse>>): Promise<void> {
  useAuthStore.setState({ user: await request });
}

/** Changes to the signed-in user's own profile. Everyone else hears through the gateway. */
export const profileApi = {
  update: (changes: UpdateProfileRequest) =>
    apply(api('PATCH', '/users/@me', { body: changes, schema: selfSchema })),
  setAvatar: (image: Blob) =>
    apply(api('PUT', '/users/@me/avatar', { body: picture(image), schema: selfSchema })),
  clearAvatar: () => apply(api('DELETE', '/users/@me/avatar', { schema: selfSchema })),
  setBanner: (image: Blob) =>
    apply(api('PUT', '/users/@me/banner', { body: picture(image), schema: selfSchema })),
  clearBanner: () => apply(api('DELETE', '/users/@me/banner', { schema: selfSchema })),
  changePassword: (currentPassword: string, newPassword: string) =>
    api('POST', '/users/@me/password', { body: { currentPassword, newPassword } }),
};
