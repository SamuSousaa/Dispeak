import {
  applyUserSettingsPatch,
  defaultUserSettings,
  PEOPLE_PREFERENCES_MAX,
  userSettingsSchema,
  type UserSettings,
  type UserSettingsPatch,
} from '@frequencia/shared';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '../../db/client';
import { badRequest } from '../../errors';
import type { GatewayBus } from '../../gateway/bus';

const { userSettings } = schema;

/**
 * Preferences that follow an account to every device. A change reaches every open session of
 * the user, so another computer picks it up without reloading.
 */
export class UserSettingsService {
  constructor(
    private readonly db: Database,
    private readonly bus: GatewayBus,
  ) {}

  async get(userId: string): Promise<UserSettings> {
    const [row] = await this.db
      .select({ data: userSettings.data })
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    return parseStored(row?.data);
  }

  async update(userId: string, patch: UserSettingsPatch): Promise<UserSettings> {
    // Read, merge and write under a row lock: two devices changing different people at the
    // same moment both keep their change.
    const next = await this.db.transaction(async (tx) => {
      await tx
        .insert(userSettings)
        .values({ userId, data: defaultUserSettings })
        .onConflictDoNothing();
      const [row] = await tx
        .select({ data: userSettings.data })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .for('update');
      const merged = applyUserSettingsPatch(parseStored(row?.data), patch);
      if (Object.keys(merged.people).length > PEOPLE_PREFERENCES_MAX) {
        throw badRequest(`preferences are kept for at most ${PEOPLE_PREFERENCES_MAX} people`);
      }
      await tx
        .update(userSettings)
        .set({ data: merged, updatedAt: new Date() })
        .where(eq(userSettings.userId, userId));
      return merged;
    });
    await this.bus.userEvent(userId, 'USER_SETTINGS_UPDATE', next);
    return next;
  }
}

/**
 * Stored data may predate a field added since: it is read field by field, and whatever no
 * longer validates falls back to the default instead of failing the whole session.
 */
function parseStored(data: unknown): UserSettings {
  if (!data || typeof data !== 'object') return defaultUserSettings;
  const stored = data as Record<string, unknown>;
  const shape = userSettingsSchema.shape;
  const field = <K extends keyof UserSettings>(key: K): UserSettings[K] => {
    const parsed = shape[key].safeParse(stored[key]);
    return parsed.success ? (parsed.data as UserSettings[K]) : defaultUserSettings[key];
  };
  return {
    people: field('people'),
    showEmbeds: field('showEmbeds'),
    privateProfile: field('privateProfile'),
  };
}
