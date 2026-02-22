import fs from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { logger } from "../utils/logger";
import { getProjectRoot } from "../utils/paths";
import { StoreError } from "./errors";

const MIGRATIONS_DIR = path.join(getProjectRoot(), "db", "migrations-supabase");
const MIGRATIONS_TABLE = "_schema_migrations";

/**
 * Ensures the migration tracking table exists in the PostgreSQL database.
 */
async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/**
 * Retrieves the set of already applied migration IDs from the tracking table.
 */
async function getAppliedMigrations(pool: Pool): Promise<Set<string>> {
  const result = await pool.query(`SELECT id FROM ${MIGRATIONS_TABLE}`);
  return new Set(result.rows.map((row: { id: string }) => row.id));
}

/**
 * Applies pending PostgreSQL migrations found in the migrations-supabase directory.
 * Each migration runs inside its own transaction to ensure atomicity.
 *
 * @param pool The pg Pool instance.
 */
export async function applyMigrationsPostgres(pool: Pool): Promise<void> {
  logger.debug("Checking PostgreSQL database migrations...");

  await ensureMigrationsTable(pool);
  const appliedMigrations = await getAppliedMigrations(pool);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new StoreError(`Supabase migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const migrationFiles = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const pendingMigrations = migrationFiles.filter(
    (filename) => !appliedMigrations.has(filename),
  );

  if (pendingMigrations.length === 0) {
    logger.debug("PostgreSQL schema is up to date");
    return;
  }

  logger.info(`🔄 Applying ${pendingMigrations.length} PostgreSQL migration(s)...`);

  for (const filename of pendingMigrations) {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filePath, "utf8");

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      logger.debug(`Applying migration: ${filename}`);
      await client.query(sql);
      await client.query(`INSERT INTO ${MIGRATIONS_TABLE} (id) VALUES ($1)`, [filename]);
      await client.query("COMMIT");
      logger.debug(`Applied migration: ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      logger.error(`❌ Failed to apply migration: ${filename} - ${error}`);
      throw new StoreError(`PostgreSQL migration failed: ${filename}`, error);
    } finally {
      client.release();
    }
  }

  logger.info(
    `✅ Successfully applied ${pendingMigrations.length} PostgreSQL migration(s)`,
  );
}
