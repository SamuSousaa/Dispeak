import { ApiErrorCode, type AuthResponse, type User } from '@frequencia/shared';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Config } from '../../config';
import { schema, type Database } from '../../db/client';
import { AppError, unauthorized } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';
import { uuidv7 } from '../../lib/ids';
import type { Redis } from '../../redis';
import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  type AccessClaims,
} from './tokens';

const { users, refreshTokens } = schema;

/** Argon2id with the OWASP-recommended minimum parameters. */
const ARGON2 = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** A just-rotated token presented again within this window is a race, not a theft. */
const ROTATION_GRACE_MS = 10_000;

const revokedKey = (sessionId: string) => `auth:revoked:${sessionId}`;

export interface IssuedSession {
  response: AuthResponse;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface RequestMeta {
  userAgent?: string;
}

export class AuthService {
  /** Verified against when the username does not exist, so both paths cost the same. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly bus: GatewayBus,
    private readonly config: Config,
  ) {}

  async register(
    input: { username: string; displayName?: string; password: string },
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const passwordHash = await hash(input.password, ARGON2);
    const [user] = await this.db
      .insert(users)
      .values({
        id: uuidv7(),
        username: input.username,
        displayName: input.displayName ?? input.username,
        passwordHash,
      })
      .onConflictDoNothing({ target: users.username })
      .returning();
    if (!user) {
      throw new AppError(409, ApiErrorCode.UsernameTaken, 'username is already taken');
    }
    return this.issue(toUser(user), uuidv7(), meta);
  }

  async login(
    input: { username: string; password: string },
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const [user] = await this.db.select().from(users).where(eq(users.username, input.username));
    this.dummyHash ??= hash('frequencia-dummy-password', ARGON2);
    const valid = await verify(user?.passwordHash ?? (await this.dummyHash), input.password);
    if (!user || !valid) {
      throw new AppError(401, ApiErrorCode.InvalidCredentials, 'invalid username or password');
    }
    return this.issue(toUser(user), uuidv7(), meta);
  }

  /** Rotates a refresh token: the presented one is revoked and its successor returned. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedSession> {
    const tokenHash = hashRefreshToken(refreshToken);
    const now = new Date();

    const [rotated] = await this.db
      .update(refreshTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, now),
        ),
      )
      .returning();

    let familyId = rotated?.familyId;
    let userId = rotated?.userId;

    if (!rotated) {
      const [existing] = await this.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, tokenHash));
      if (!existing || existing.expiresAt <= now || !existing.revokedAt) throw unauthorized();

      const sinceRevoked = now.getTime() - existing.revokedAt.getTime();
      const familyAlive = await this.isFamilyAlive(existing.familyId);
      if (sinceRevoked > ROTATION_GRACE_MS || !familyAlive) {
        // A revoked token came back: assume it leaked and end the whole session.
        await this.revokeFamily(existing.userId, existing.familyId);
        throw unauthorized('session revoked');
      }
      // Two tabs refreshed at the same time; let the slower one continue the session.
      familyId = existing.familyId;
      userId = existing.userId;
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId as string));
    if (!user) throw unauthorized();
    return this.issue(toUser(user), familyId as string, meta);
  }

  /** Ends the session a refresh token belongs to. Unknown tokens are ignored. */
  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    const [token] = await this.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(refreshToken)));
    if (token) await this.revokeFamily(token.userId, token.familyId);
  }

  /** Ends every session of a user, on every device. */
  async logoutAll(userId: string): Promise<void> {
    const active = await this.db
      .selectDistinct({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));
    await Promise.all(active.map(({ familyId }) => this.denySession(familyId)));
    await this.bus.publish({ kind: 'session-revoked', userId, sessionId: null });
  }

  /** Validates an access token, including whether its session was revoked meanwhile. */
  async authenticate(accessToken: string): Promise<AccessClaims | null> {
    const claims = await verifyAccessToken(accessToken, this.config.JWT_SECRET);
    if (!claims) return null;
    if (await this.redis.exists(revokedKey(claims.sessionId))) return null;
    return claims;
  }

  async getUser(userId: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    return user ? toUser(user) : null;
  }

  private async issue(user: User, familyId: string, meta: RequestMeta): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    await this.db.insert(refreshTokens).values({
      id: uuidv7(),
      userId: user.id,
      familyId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshExpiresAt,
      userAgent: meta.userAgent?.slice(0, 256),
    });
    const accessToken = await signAccessToken(
      { userId: user.id, sessionId: familyId },
      this.config.JWT_SECRET,
      this.config.ACCESS_TOKEN_TTL_SECONDS,
    );
    return {
      response: { accessToken, expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS, user },
      refreshToken,
      refreshExpiresAt,
    };
  }

  private async isFamilyAlive(familyId: string): Promise<boolean> {
    const [alive] = await this.db
      .select({ id: refreshTokens.id })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .limit(1);
    return Boolean(alive);
  }

  private async revokeFamily(userId: string, familyId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
    await this.denySession(familyId);
    await this.bus.publish({ kind: 'session-revoked', userId, sessionId: familyId });
  }

  /** Access tokens are stateless; a short-lived denylist entry covers their remaining life. */
  private async denySession(sessionId: string): Promise<void> {
    await this.redis.set(revokedKey(sessionId), '1', 'EX', this.config.ACCESS_TOKEN_TTL_SECONDS);
  }
}

function toUser(row: typeof users.$inferSelect): User {
  return { id: row.id, username: row.username, displayName: row.displayName };
}
