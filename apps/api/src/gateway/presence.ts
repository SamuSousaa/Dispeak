import type { Redis } from '../redis';

const key = (userId: string) => `presence:${userId}`;

/**
 * Online presence in Redis, shared by every API instance. Each user has a hash of
 * `gateway session id -> expiry timestamp`; the user is online while any entry is still
 * alive. Entries are refreshed by heartbeats, so a crashed instance cannot leave a user
 * online forever.
 */
export class PresenceService {
  constructor(
    private readonly redis: Redis,
    /** How long an entry stays alive without being refreshed. */
    private readonly ttlMs: number,
  ) {}

  /** Registers a session. Resolves `true` when this made the user come online. */
  async connect(userId: string, sessionId: string): Promise<boolean> {
    const wasOnline = await this.isOnline(userId);
    await this.touch(userId, sessionId);
    return !wasOnline;
  }

  /** Refreshes a session's expiry. */
  async touch(userId: string, sessionId: string): Promise<void> {
    await this.redis
      .multi()
      .hset(key(userId), sessionId, String(Date.now() + this.ttlMs))
      .pexpire(key(userId), this.ttlMs)
      .exec();
  }

  /** Removes a session. Resolves `true` when the user has no session left. */
  async disconnect(userId: string, sessionId: string): Promise<boolean> {
    await this.redis.hdel(key(userId), sessionId);
    return !(await this.isOnline(userId));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.onlineAmong([userId])).length > 0;
  }

  /** Filters a list of users down to the ones currently online. */
  async onlineAmong(userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.hvals(key(userId));
    const results = (await pipeline.exec()) ?? [];
    const now = Date.now();
    return userIds.filter((_, index) => {
      const expiries = (results[index]?.[1] as string[] | null) ?? [];
      return expiries.some((expiry) => Number(expiry) > now);
    });
  }
}
