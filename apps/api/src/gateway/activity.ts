import { activitySchema, type Activity } from '@frequencia/shared';
import type { Redis } from '../redis';
import { presenceKey } from './presence';

const key = (userId: string) => `activity:${userId}`;
/** Leftovers of sessions that never said goodbye go with the key after this long. */
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * What users are doing (the game the desktop app sees running), per gateway session, in
 * Redis beside their presence: `activity:<user>` holds `session id -> activity`. An entry only
 * counts while its session is online, so a crashed instance leaves nothing behind for long.
 * Several sessions: the one that started last wins.
 */
export class ActivityService {
  constructor(private readonly redis: Redis) {}

  /** Sets (or clears) a session's activity. Resolves with the user's activity afterwards. */
  async set(userId: string, sessionId: string, game: string | null): Promise<Activity | null> {
    if (game) {
      // The same game again keeps its start.
      const [current] = await this.entries(userId, [sessionId]);
      const activity: Activity =
        current?.game === game ? current : { game, since: new Date().toISOString() };
      await this.redis
        .multi()
        .hset(key(userId), sessionId, JSON.stringify(activity))
        .pexpire(key(userId), KEY_TTL_MS)
        .exec();
    } else {
      await this.redis.hdel(key(userId), sessionId);
    }
    return this.of(userId);
  }

  /** What a user is doing now, from their sessions still online. */
  async of(userId: string): Promise<Activity | null> {
    return (await this.among([userId]))[userId] ?? null;
  }

  /** Activities of the users given, leaving out those with none. */
  async among(userIds: readonly string[]): Promise<Record<string, Activity>> {
    if (userIds.length === 0) return {};
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) {
      pipeline.hgetall(key(userId));
      pipeline.hgetall(presenceKey(userId));
    }
    const results = (await pipeline.exec()) ?? [];
    const now = Date.now();
    const found: Record<string, Activity> = {};
    userIds.forEach((userId, index) => {
      const activities = (results[index * 2]?.[1] ?? {}) as Record<string, string>;
      const sessions = (results[index * 2 + 1]?.[1] ?? {}) as Record<string, string>;
      let latest: Activity | null = null;
      for (const [sessionId, raw] of Object.entries(activities)) {
        if (!(Number(sessions[sessionId]) > now)) continue;
        const activity = parse(raw);
        if (activity && (!latest || activity.since > latest.since)) latest = activity;
      }
      if (latest) found[userId] = latest;
    });
    return found;
  }

  private async entries(userId: string, sessionIds: string[]): Promise<Array<Activity | null>> {
    const raw = await this.redis.hmget(key(userId), ...sessionIds);
    return raw.map((value) => (value ? parse(value) : null));
  }
}

function parse(raw: string): Activity | null {
  try {
    const parsed = activitySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
