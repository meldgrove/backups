import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "../db/client";
import { settings } from "../db/schema";

/**
 * Settings made in the app, one JSON value per key. Secrets inside a value
 * are stored encrypted (core/crypto.ts); readers decrypt them.
 */
export async function readSetting<T>(db: DbOrTx, key: string): Promise<T | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function writeSetting<T>(db: DbOrTx, key: string, value: T): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: sql`now()` } });
}

/** Changes a stored value with `change` (null when there is none yet) inside one statement's transaction. */
export async function updateSetting<T>(
  db: DbOrTx,
  key: string,
  change: (current: T | null) => T,
): Promise<T> {
  const next = change(await readSetting<T>(db, key));
  await writeSetting(db, key, next);
  return next;
}
