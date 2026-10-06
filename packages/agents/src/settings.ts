import { and, desc, eq } from "drizzle-orm";
import { settings, type Db } from "@oa/db";
import { AssistantSettings } from "@oa/shared";

const KEY = "assistant";
const TTL_MS = 10_000;
let cache: { at: number; value: AssistantSettings } | null = null;

/** Active assistant settings, with defaults filled in for anything not set. */
export async function loadSettings(db: Db): Promise<AssistantSettings> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.key, KEY), eq(settings.active, true)))
    .orderBy(desc(settings.version))
    .limit(1);
  const value = AssistantSettings.parse(row?.value ?? {});
  cache = { at: Date.now(), value };
  return value;
}

/** Saves a new version and makes it active; earlier versions stay for history and rollback. */
export async function saveSettings(db: Db, value: unknown, changedBy: string): Promise<{ version: number; value: AssistantSettings }> {
  const parsed = AssistantSettings.parse(value);
  const version = await db.transaction(async (tx) => {
    const [latest] = await tx.select({ version: settings.version }).from(settings).where(eq(settings.key, KEY)).orderBy(desc(settings.version)).limit(1);
    const next = (latest?.version ?? 0) + 1;
    await tx.update(settings).set({ active: false }).where(eq(settings.key, KEY));
    await tx.insert(settings).values({ key: KEY, value: parsed, version: next, active: true, changedBy });
    return next;
  });
  cache = null;
  return { version, value: parsed };
}

export async function settingsHistory(db: Db) {
  return db.select().from(settings).where(eq(settings.key, KEY)).orderBy(desc(settings.version)).limit(50);
}

/** Makes an earlier version active again. */
export async function activateSettingsVersion(db: Db, version: number): Promise<boolean> {
  const done = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(settings).where(and(eq(settings.key, KEY), eq(settings.version, version)));
    if (!row) return false;
    await tx.update(settings).set({ active: false }).where(eq(settings.key, KEY));
    await tx.update(settings).set({ active: true }).where(eq(settings.id, row.id));
    return true;
  });
  cache = null;
  return done;
}
