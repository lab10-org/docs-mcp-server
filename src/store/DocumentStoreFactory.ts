import path from "node:path";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import type { IDocumentStore } from "./IDocumentStore";
import { SqliteDocumentStore } from "./SqliteDocumentStore";

/**
 * Creates the appropriate document store implementation based on the app configuration.
 *
 * - `"sqlite"` (default): uses the local SQLite-based store.
 * - `"supabase"`: dynamically imports the Supabase/PostgreSQL-based store to avoid
 *   pulling in `pg` / `pgvector` when they aren't needed.
 */
export async function createDocumentStore(appConfig: AppConfig): Promise<IDocumentStore> {
  const provider = appConfig.storage.provider;

  switch (provider) {
    case "sqlite": {
      const storePath = appConfig.app.storePath;
      if (!storePath) {
        throw new Error("storePath is required for the sqlite storage provider");
      }
      const dbPath =
        storePath === ":memory:" ? ":memory:" : path.join(storePath, "documents.db");
      logger.debug(`Creating SQLite document store at: ${dbPath}`);
      return new SqliteDocumentStore(dbPath, appConfig);
    }

    case "supabase": {
      logger.debug("Creating Supabase document store");
      // Dynamic import to avoid loading pg/pgvector for SQLite-only users
      const { SupabaseDocumentStore } = await import("./SupabaseDocumentStore");
      return new SupabaseDocumentStore(appConfig);
    }

    default:
      throw new Error(`Unknown storage provider: ${provider}`);
  }
}
