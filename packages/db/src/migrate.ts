/**
 * Apply SQL migrations from ./drizzle to whichever database `createDb` resolves.
 * Usable as a CLI (`npm run db:migrate`) and as a function (tests, server boot).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { createDb, type DbHandle } from "./client.js";
import type * as schema from "./schema.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_FOLDER = path.resolve(here, "../drizzle");

export async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.driver === "pg") {
    await migratePg(handle.db as NodePgDatabase<typeof schema>, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    await migratePglite(handle.db as PgliteDatabase<typeof schema>, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const handle = await createDb();
  await runMigrations(handle);
  console.log(`Migrations applied (${handle.driver}).`);
  await handle.close();
}
