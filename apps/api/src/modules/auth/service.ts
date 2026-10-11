import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ApiErrorCode,
  type AuthResponse,
  type Self,
  PASSWORD_RESET_TTL_SECONDS,
  type PasswordResetLink,
} from '@frequencia/shared';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Config } from '../../config';
import { schema, type Database, type Queryable } from '../../db/client';
import { AppError, unauthorized } from '../../errors';
import { toSelf } from '../../lib/user';
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

const { users, refreshTokens, passwordResets } = schema;

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

/** Compares two secrets without telling, by the time it takes, how much of one was right. */
function sameSecret(given: string, wanted: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(wanted).digest();
  return timingSafeEqual(a, b);
}

export class AuthService {
  /** Whether new accounts need the access code. */
  get accessCodeRequired(): boolean {
    return this.config.REGISTRATION_CODE !== undefined;
  }

  /** Verified against when the username does not exist, so both paths cost the same. */
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis,
    private readonly bus: GatewayBus,
    private readonly config: Config,
  ) {}

  async register(
    input: { username: string; displayName?: string; password: string; accessCode?: string },
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const wanted = this.config.REGISTRATION_CODE;
    if (wanted !== undefined && !sameSecret(input.accessCode ?? '', wanted)) {
      throw new AppError(403, ApiErrorCode.AccessCodeInvalid, 'wrong access code');
    }
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
    return this.issue(toSelf(user), uuidv7(), meta);
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
    return this.issue(toSelf(user), uuidv7(), meta);
  }

  /** Rotates a refresh token: the presented one is revoked and its successor returned. */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<IssuedSession> {
    const tokenHash = hashRefreshToken(refreshToken);
    const now = new Date();

    // The old token is revoked and its successor stored in one transaction. A second tab
    // refreshing at the same moment waits on the row, and then finds the session still alive
    // instead of a family with no live token (which reads as theft and ends the session).
    const rotated = await this.db.transaction(async (tx) => {
      const [token] = await tx
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
      if (!token) return null;
      const [user] = await tx.select().from(users).where(eq(users.id, token.userId));
      return user ? this.issue(toSelf(user), token.familyId, meta, tx) : 'no-user';
    });
    if (rotated === 'no-user') throw unauthorized();
    if (rotated) return rotated;

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
    const [user] = await this.db.select().from(users).where(eq(users.id, existing.userId));
    if (!user) throw unauthorized();
    return this.issue(toSelf(user), existing.familyId, meta);
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

  /**
   * Changes the password after checking the current one, and signs the user out everywhere:
   * whoever had a session open with the old password has to come back with the new one.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || !(await verify(user.passwordHash, currentPassword))) {
      throw new AppError(401, ApiErrorCode.InvalidCredentials, 'the current password is wrong');
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hash(newPassword, ARGON2) })
      .where(eq(users.id, userId));
    await this.logoutAll(userId);
  }

  /**
   * Makes a one-time link for someone who forgot their password. Whoever calls this has
   * already been checked; the link works for an hour and replaces any earlier one.
   */
  async createPasswordReset(userId: string, createdBy: string): Promise<PasswordResetLink> {
    const token = generateRefreshToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_SECONDS * 1000);
    await this.db.transaction(async (tx) => {
      await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
      await tx
        .insert(passwordResets)
        .values({ tokenHash: hashRefreshToken(token), userId, createdBy, expiresAt });
    });
    return { token, expiresAt: expiresAt.toISOString() };
  }

  /** Sets a new password with a reset link, once, and signs every session of the user out. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const [used] = await this.db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.tokenHash, hashRefreshToken(token)),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!used) {
      throw new AppError(404, ApiErrorCode.NotFound, 'this link is invalid or has expired');
    }
    await this.db
      .update(users)
      .set({ passwordHash: await hash(newPassword, ARGON2) })
      .where(eq(users.id, used.userId));
    await this.logoutAll(used.userId);
  }

  async getUser(userId: string): Promise<Self | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    return user ? toSelf(user) : null;
  }

  private async issue(
    user: Self,
    familyId: string,
    meta: RequestMeta,
    db: Queryable = this.db,
  ): Promise<IssuedSession> {
    const refreshToken = generateRefreshToken();
    const refreshExpiresAt = new Date(
      Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
    await db.insert(refreshTokens).values({
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
