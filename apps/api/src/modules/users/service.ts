import type { Self, UpdateProfileRequest } from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { notFound } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { toSelf } from '../../lib/user';
import type { PictureStore } from './pictures';

const { users, guildMembers } = schema;

/** What users change about themselves. Every change reaches the guilds they are in. */
export class UserService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
    private readonly pictures: PictureStore,
  ) {}

  /** Sets the profile picture, or removes it with `null`. */
  setAvatar(userId: string, data: Buffer | null): Promise<Self> {
    return this.setPicture(userId, 'avatarId', data);
  }

  /** Sets the picture on top of the profile card, or removes it with `null`. */
  setBanner(userId: string, data: Buffer | null): Promise<Self> {
    return this.setPicture(userId, 'bannerId', data);
  }

  /** Name, "about me", status line, accent colour and how the user wants to be seen. */
  async updateProfile(userId: string, changes: UpdateProfileRequest): Promise<Self> {
    await this.find(userId);
    // Nothing to change is not an error, and an UPDATE without columns would be one.
    if (Object.values(changes).every((value) => value === undefined)) {
      return toSelf(await this.find(userId));
    }
    const empty = (text: string | null | undefined) =>
      text === undefined ? undefined : text?.trim() || null;
    await this.db
      .update(users)
      .set({
        displayName: changes.displayName,
        bio: empty(changes.bio),
        customStatus: empty(changes.customStatus),
        accentColor:
          changes.accentColor === undefined
            ? undefined
            : (changes.accentColor?.toLowerCase() ?? null),
        presenceMode: changes.presence,
      })
      .where(eq(users.id, userId));
    return this.announce(userId);
  }

  private async setPicture(
    userId: string,
    column: 'avatarId' | 'bannerId',
    data: Buffer | null,
  ): Promise<Self> {
    const current = await this.find(userId);
    const id = data ? await this.pictures.store(data) : null;
    await this.db
      .update(users)
      .set({ [column]: id })
      .where(eq(users.id, userId));
    await this.pictures.discard(current[column]);
    return this.announce(userId);
  }

  private async find(userId: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user) throw notFound('user');
    return user;
  }

  /**
   * Tells every guild the user belongs to. A full sync, because the change may also be about
   * who counts as online (going invisible and back).
   */
  private async announce(userId: string): Promise<Self> {
    const memberships = await this.db
      .select({ guildId: guildMembers.guildId })
      .from(guildMembers)
      .where(eq(guildMembers.userId, userId));
    await Promise.all(memberships.map(({ guildId }) => this.bus.sync(guildId)));
    return toSelf(await this.find(userId));
  }
}
