/**
 * Database client factory.
 *  - DATABASE_URL set  -> node-postgres (production / shared dev DB)
 *  - DATABASE_URL unset -> embedded PGlite persisted at PGLITE_DIR (default ./.pglite), or in-memory for tests.
 */
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  /** "pg" or "pglite" */
  driver: "pg" | "pglite";
  close(): Promise<void>;
  /** Underlying PGlite instance (only for pglite driver) - used by the migrator. */
  pglite?: PGlite;
  pool?: pg.Pool;
}

export interface CreateDbOptions {
  databaseUrl?: string | undefined;
  /** For PGlite: directory to persist to. Use "memory://" for ephemeral (tests). */
  pgliteDir?: string | undefined;
}

export async function createDb(opts: CreateDbOptions = {}): Promise<DbHandle> {
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const pool = new pg.Pool({ connectionString: url });
    const db = drizzlePg(pool, { schema, casing: "snake_case" });
    return { db, driver: "pg", pool, close: () => pool.end() };
  }
  const dir = opts.pgliteDir ?? process.env.PGLITE_DIR ?? "./.pglite";
  const pglite = dir === "memory://" ? new PGlite() : new PGlite(dir);
  await pglite.waitReady;
  const db = drizzlePglite(pglite, { schema, casing: "snake_case" });
  return { db, driver: "pglite", pglite, close: () => pglite.close() };
}
