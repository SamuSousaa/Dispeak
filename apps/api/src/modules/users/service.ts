import type { User } from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import type { PictureStore } from './pictures';

const { users, guildMembers } = schema;

/** What users change about themselves. */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
    private readonly pictures: PictureStore,
  ) {}

  /** Sets the profile picture, or removes it with `null`, and tells every guild the user is in. */
  async setAvatar(userId: string, data: Buffer | null): Promise<User> {
    const [current] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!current) throw notFound('user');
    const avatar = data ? await this.pictures.store(data) : null;
    await this.db.update(users).set({ avatarId: avatar }).where(eq(users.id, userId));
    await this.pictures.discard(current.avatarId);

    const memberships = await this.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, userId));
    await Promise.all(memberships.map(({ guildId }) => this.bus.sync(guildId)));

    return {
      id: current.id,
      username: current.username,
      displayName: current.displayName,
      avatar,
    };
  }
}
