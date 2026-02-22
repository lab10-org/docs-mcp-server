import type { Embeddings } from "@langchain/core/embeddings";
import type { Pool, PoolClient } from "pg";
import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import type { AppConfig } from "../utils/config";
import { logger } from "../utils/logger";
import { compareVersionsDescending } from "../utils/version";
import { applyMigrationsPostgres } from "./applyMigrationsPostgres";
import { EmbeddingConfig, type EmbeddingModelConfig } from "./embeddings/EmbeddingConfig";
import {
  areCredentialsAvailable,
  createEmbeddingModel,
  ModelConfigurationError,
  UnsupportedProviderError,
} from "./embeddings/EmbeddingFactory";
import { ConnectionError, DimensionError, StoreError } from "./errors";
import type { IDocumentStore } from "./IDocumentStore";
import type {
  DbChunkMetadata,
  DbChunkRank,
  DbPage,
  DbPageChunk,
  DbVersion,
  DbVersionWithLibrary,
  StoredScraperOptions,
  VersionScraperOptions,
  VersionStatus,
} from "./types";
import { denormalizeVersionName, normalizeVersionName } from "./types";

// ── Helpers ────────────────────────────────────────────────────────────

/** Convert a `number[]` embedding to the pgvector literal format `[0.1,0.2,...]` */
function toPgVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// ── Main class ─────────────────────────────────────────────────────────

/**
 * Document store backed by Supabase (PostgreSQL) with pgvector for
 * vector similarity search and tsvector/tsquery for full-text search.
 */
export class SupabaseDocumentStore implements IDocumentStore {
  private readonly config: AppConfig;
  private pool!: Pool;
  private embeddings!: Embeddings;

  private readonly dbDimension: number;
  private readonly searchWeightVec: number;
  private readonly searchWeightFts: number;
  private readonly searchOverfetchFactor: number;
  private readonly vectorSearchMultiplier: number;
  private readonly splitterMaxChunkSize: number;
  private readonly embeddingBatchSize: number;
  private readonly embeddingBatchChars: number;
  private readonly embeddingInitTimeoutMs: number;

  private modelDimension!: number;
  private readonly embeddingConfig?: EmbeddingModelConfig | null;
  private isVectorSearchEnabled = false;

  constructor(appConfig: AppConfig) {
    this.config = appConfig;
    this.dbDimension = this.config.embeddings.vectorDimension;
    this.searchWeightVec = this.config.search.weightVec;
    this.searchWeightFts = this.config.search.weightFts;
    this.searchOverfetchFactor = this.config.search.overfetchFactor;
    this.vectorSearchMultiplier = this.config.search.vectorMultiplier;
    this.splitterMaxChunkSize = this.config.splitter.maxChunkSize;
    this.embeddingBatchSize = this.config.embeddings.batchSize;
    this.embeddingBatchChars = this.config.embeddings.batchChars;
    this.embeddingInitTimeoutMs = this.config.embeddings.initTimeoutMs;

    this.embeddingConfig = this.resolveEmbeddingConfig(appConfig.app.embeddingModel);
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    try {
      // Dynamic import so pg is only loaded for supabase users
      const pg = await import("pg");
      const PgPool = pg.default?.Pool ?? pg.Pool;

      const connectionString = this.config.storage.supabase.connectionString;
      if (!connectionString) {
        throw new StoreError(
          "A PostgreSQL connection string (DATABASE_URL) is required for the supabase storage provider",
        );
      }

      this.pool = new PgPool({
        connectionString,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
      });

      // Verify connectivity
      const client = await this.pool.connect();
      client.release();

      // Configure PostgreSQL schema if specified
      const schema = this.config.storage.supabase.schema;
      if (schema) {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
          throw new StoreError(`Invalid PostgreSQL schema name: ${schema}`);
        }

        // Set search_path on every new connection from the pool
        this.pool.on("connect", (poolClient: PoolClient) => {
          poolClient.query(`SET search_path TO ${schema}, public`);
        });

        // Create schema if it doesn't exist
        const schemaClient = await this.pool.connect();
        try {
          await schemaClient.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
          await schemaClient.query(`SET search_path TO ${schema}, public`);
        } finally {
          schemaClient.release();
        }
      }

      // Run migrations
      await applyMigrationsPostgres(this.pool);

      // Initialize embeddings
      await this.initializeEmbeddings();
    } catch (error) {
      if (
        error instanceof StoreError ||
        error instanceof ModelConfigurationError ||
        error instanceof UnsupportedProviderError
      ) {
        throw error;
      }
      throw new ConnectionError("Failed to initialize Supabase document store", error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }

  // ── Embedding configuration ────────────────────────────────────────

  getActiveEmbeddingConfig(): EmbeddingModelConfig | null {
    if (!this.isVectorSearchEnabled || !this.embeddingConfig) {
      return null;
    }
    return this.embeddingConfig;
  }

  // ── Library / version resolution ───────────────────────────────────

  async resolveVersionId(library: string, version: string): Promise<number> {
    const normalizedLibrary = library.toLowerCase();
    const normalizedVersion = denormalizeVersionName(version.toLowerCase());

    // Upsert library
    await this.pool.query(
      "INSERT INTO libraries (name) VALUES ($1) ON CONFLICT (name) DO NOTHING",
      [normalizedLibrary],
    );
    const libResult = await this.pool.query("SELECT id FROM libraries WHERE name = $1", [
      normalizedLibrary,
    ]);
    if (libResult.rows.length === 0) {
      throw new StoreError(`Failed to resolve library_id for library: ${library}`);
    }
    const libraryId = libResult.rows[0].id;

    // Upsert version
    await this.pool.query(
      "INSERT INTO versions (library_id, name, status) VALUES ($1, $2, 'not_indexed') ON CONFLICT (library_id, name) DO NOTHING",
      [libraryId, normalizedVersion],
    );
    const verResult = await this.pool.query(
      "SELECT id FROM versions WHERE library_id = $1 AND name = $2",
      [libraryId, normalizedVersion],
    );
    if (verResult.rows.length === 0) {
      throw new StoreError(
        `Failed to resolve version_id for library: ${library}, version: ${version}`,
      );
    }
    return verResult.rows[0].id;
  }

  async queryUniqueVersions(library: string): Promise<string[]> {
    try {
      const result = await this.pool.query(
        `SELECT DISTINCT v.name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
         ORDER BY v.name`,
        [library.toLowerCase()],
      );
      return result.rows.map((row: { name: string | null }) =>
        normalizeVersionName(row.name),
      );
    } catch (error) {
      throw new ConnectionError("Failed to query versions", error);
    }
  }

  async queryLibraryVersions(): Promise<
    Map<
      string,
      Array<{
        version: string;
        versionId: number;
        status: VersionStatus;
        progressPages: number;
        progressMaxPages: number;
        sourceUrl: string | null;
        documentCount: number;
        uniqueUrlCount: number;
        indexedAt: string | null;
      }>
    >
  > {
    try {
      const result = await this.pool.query(`
        SELECT
          l.name as library,
          COALESCE(v.name, '') as version,
          v.id as "versionId",
          v.status as status,
          v.progress_pages as "progressPages",
          v.progress_max_pages as "progressMaxPages",
          v.source_url as "sourceUrl",
          MIN(p.created_at) as "indexedAt",
          COUNT(d.id)::int as "documentCount",
          COUNT(DISTINCT p.url)::int as "uniqueUrlCount"
        FROM versions v
        JOIN libraries l ON v.library_id = l.id
        LEFT JOIN pages p ON p.version_id = v.id
        LEFT JOIN documents d ON d.page_id = p.id
        GROUP BY v.id, l.name
        ORDER BY l.name, version
      `);

      const libraryMap = new Map<
        string,
        Array<{
          version: string;
          versionId: number;
          status: VersionStatus;
          progressPages: number;
          progressMaxPages: number;
          sourceUrl: string | null;
          documentCount: number;
          uniqueUrlCount: number;
          indexedAt: string | null;
        }>
      >();

      for (const row of result.rows) {
        const lib = row.library;
        if (!libraryMap.has(lib)) {
          libraryMap.set(lib, []);
        }
        const indexedAtISO = row.indexedAt ? new Date(row.indexedAt).toISOString() : null;
        libraryMap.get(lib)?.push({
          version: row.version,
          versionId: row.versionId,
          status: row.status as VersionStatus,
          progressPages: row.progressPages,
          progressMaxPages: row.progressMaxPages,
          sourceUrl: row.sourceUrl,
          documentCount: row.documentCount,
          uniqueUrlCount: row.uniqueUrlCount,
          indexedAt: indexedAtISO,
        });
      }

      for (const versions of libraryMap.values()) {
        versions.sort((a, b) => compareVersionsDescending(a.version, b.version));
      }

      return libraryMap;
    } catch (error) {
      throw new ConnectionError("Failed to query library versions", error);
    }
  }

  async checkDocumentExists(library: string, version: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `SELECT d.id FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
         AND COALESCE(v.name, '') = COALESCE($2, '')
         LIMIT 1`,
        [library.toLowerCase(), version.toLowerCase()],
      );
      return result.rows.length > 0;
    } catch (error) {
      throw new ConnectionError("Failed to check document existence", error);
    }
  }

  // ── Version CRUD ───────────────────────────────────────────────────

  async getVersionById(versionId: number): Promise<DbVersion | null> {
    try {
      const result = await this.pool.query("SELECT * FROM versions WHERE id = $1", [
        versionId,
      ]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw new StoreError(`Failed to get version by ID: ${error}`);
    }
  }

  async getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]> {
    try {
      const result = await this.pool.query(
        `SELECT v.*, l.name as library_name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE v.status = ANY($1)`,
        [statuses],
      );
      return result.rows;
    } catch (error) {
      throw new StoreError(`Failed to get versions by status: ${error}`);
    }
  }

  async updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void> {
    try {
      await this.pool.query(
        "UPDATE versions SET status = $1, error_message = $2, updated_at = NOW() WHERE id = $3",
        [status, errorMessage ?? null, versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to update version status: ${error}`);
    }
  }

  async updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void> {
    try {
      await this.pool.query(
        "UPDATE versions SET progress_pages = $1, progress_max_pages = $2, updated_at = NOW() WHERE id = $3",
        [pages, maxPages, versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to update version progress: ${error}`);
    }
  }

  // ── Library CRUD ───────────────────────────────────────────────────

  async getLibraryById(libraryId: number): Promise<{ id: number; name: string } | null> {
    try {
      const result = await this.pool.query("SELECT * FROM libraries WHERE id = $1", [
        libraryId,
      ]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw new StoreError(`Failed to get library by ID: ${error}`);
    }
  }

  async getLibrary(name: string): Promise<{ id: number; name: string } | null> {
    try {
      const normalizedName = name.toLowerCase();
      const result = await this.pool.query("SELECT id FROM libraries WHERE name = $1", [
        normalizedName,
      ]);
      if (result.rows.length === 0) return null;
      return { id: result.rows[0].id, name: normalizedName };
    } catch (error) {
      throw new StoreError(`Failed to get library by name: ${error}`);
    }
  }

  async deleteLibrary(libraryId: number): Promise<void> {
    try {
      await this.pool.query("DELETE FROM libraries WHERE id = $1", [libraryId]);
    } catch (error) {
      throw new StoreError(`Failed to delete library: ${error}`);
    }
  }

  // ── Scraper options ────────────────────────────────────────────────

  async storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void> {
    try {
      const {
        url: source_url,
        library: _library,
        version: _version,
        signal: _signal,
        initialQueue: _initialQueue,
        isRefresh: _isRefresh,
        ...scraper_options
      } = options;

      const optionsJson = JSON.stringify(scraper_options);
      await this.pool.query(
        "UPDATE versions SET source_url = $1, scraper_options = $2, updated_at = NOW() WHERE id = $3",
        [source_url, optionsJson, versionId],
      );
    } catch (error) {
      throw new StoreError(`Failed to store scraper options: ${error}`);
    }
  }

  async getScraperOptions(versionId: number): Promise<StoredScraperOptions | null> {
    try {
      const result = await this.pool.query("SELECT * FROM versions WHERE id = $1", [
        versionId,
      ]);
      const row = result.rows[0] as DbVersion | undefined;
      if (!row?.source_url) return null;

      let parsed: VersionScraperOptions = {} as VersionScraperOptions;
      if (row.scraper_options) {
        try {
          parsed = JSON.parse(row.scraper_options) as VersionScraperOptions;
        } catch (e) {
          logger.warn(`⚠️  Invalid scraper_options JSON for version ${versionId}: ${e}`);
          parsed = {} as VersionScraperOptions;
        }
      }

      return { sourceUrl: row.source_url, options: parsed };
    } catch (error) {
      throw new StoreError(`Failed to get scraper options: ${error}`);
    }
  }

  async findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]> {
    try {
      const result = await this.pool.query(
        `SELECT v.*, l.name as library_name
         FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE v.source_url = $1
         ORDER BY v.created_at DESC`,
        [url],
      );
      return result.rows;
    } catch (error) {
      throw new StoreError(`Failed to find versions by source URL: ${error}`);
    }
  }

  // ── Document CRUD ──────────────────────────────────────────────────

  async addDocuments(
    library: string,
    version: string,
    depth: number,
    result: ScrapeResult,
  ): Promise<void> {
    try {
      const { title, url, chunks } = result;
      if (chunks.length === 0) return;

      // Generate embeddings
      let paddedEmbeddings: number[][] = [];

      if (this.isVectorSearchEnabled) {
        const texts = chunks.map((chunk) => {
          const header = `<title>${title}</title>\n<url>${url}</url>\n<path>${(chunk.section.path || []).join(" / ")}</path>\n`;
          return `${header}${chunk.content}`;
        });

        for (let i = 0; i < chunks.length; i++) {
          const bodySize = chunks[i].content.length;
          if (bodySize > this.splitterMaxChunkSize) {
            logger.warn(
              `⚠️  Chunk ${i + 1}/${chunks.length} body exceeds max size: ${bodySize} > ${this.splitterMaxChunkSize} chars (URL: ${url})`,
            );
          }
        }

        const rawEmbeddings = await this.batchEmbed(texts);
        paddedEmbeddings = rawEmbeddings.map((v) => this.padVector(v));
      }

      // Resolve version
      const versionId = await this.resolveVersionId(library, version);

      // Delete existing documents for this page
      const existingPage = await this.pool.query(
        "SELECT id FROM pages WHERE version_id = $1 AND url = $2",
        [versionId, url],
      );

      if (existingPage.rows.length > 0) {
        const pageId = existingPage.rows[0].id;
        const delResult = await this.pool.query(
          "DELETE FROM documents WHERE page_id = $1",
          [pageId],
        );
        if (delResult.rowCount && delResult.rowCount > 0) {
          logger.debug(
            `Deleted ${delResult.rowCount} existing documents for URL: ${url}`,
          );
        }
      }

      // Transaction: upsert page + insert chunks
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");

        const contentType = result.contentType || null;
        const etag = result.etag || null;
        const lastModified = result.lastModified || null;

        // Upsert page
        await client.query(
          `INSERT INTO pages (version_id, url, title, etag, last_modified, content_type, depth)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (version_id, url) DO UPDATE SET
             title = EXCLUDED.title,
             content_type = EXCLUDED.content_type,
             etag = EXCLUDED.etag,
             last_modified = EXCLUDED.last_modified,
             depth = EXCLUDED.depth`,
          [versionId, url, title || "", etag, lastModified, contentType, depth],
        );

        const pageResult = await client.query(
          "SELECT id FROM pages WHERE version_id = $1 AND url = $2",
          [versionId, url],
        );
        const pageId = pageResult.rows[0].id;

        // Insert chunks in batches
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const metadata: DbChunkMetadata = {
            types: chunk.types,
            level: chunk.section.level,
            path: chunk.section.path,
          };

          const embeddingParam =
            this.isVectorSearchEnabled && paddedEmbeddings.length > 0
              ? toPgVector(paddedEmbeddings[i])
              : null;

          await client.query(
            `INSERT INTO documents (page_id, content, metadata, sort_order, embedding)
             VALUES ($1, $2, $3, $4, $5::vector)`,
            [pageId, chunk.content, JSON.stringify(metadata), i, embeddingParam],
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    } catch (error) {
      throw new ConnectionError("Failed to add documents to store", error);
    }
  }

  async deletePages(library: string, version: string): Promise<number> {
    try {
      const normalizedVersion = version.toLowerCase();
      // Delete documents first
      const docResult = await this.pool.query(
        `DELETE FROM documents
         WHERE page_id IN (
           SELECT p.id FROM pages p
           JOIN versions v ON p.version_id = v.id
           JOIN libraries l ON v.library_id = l.id
           WHERE l.name = $1 AND COALESCE(v.name, '') = COALESCE($2, '')
         )`,
        [library.toLowerCase(), normalizedVersion],
      );

      // Then delete pages
      await this.pool.query(
        `DELETE FROM pages
         WHERE version_id IN (
           SELECT v.id FROM versions v
           JOIN libraries l ON v.library_id = l.id
           WHERE l.name = $1 AND COALESCE(v.name, '') = COALESCE($2, '')
         )`,
        [library.toLowerCase(), normalizedVersion],
      );

      return docResult.rowCount ?? 0;
    } catch (error) {
      throw new ConnectionError("Failed to delete documents", error);
    }
  }

  async deletePage(pageId: number): Promise<void> {
    try {
      const docResult = await this.pool.query(
        "DELETE FROM documents WHERE page_id = $1",
        [pageId],
      );
      logger.debug(
        `Deleted ${docResult.rowCount ?? 0} document(s) for page ID ${pageId}`,
      );

      const pageResult = await this.pool.query("DELETE FROM pages WHERE id = $1", [
        pageId,
      ]);
      if (pageResult.rowCount && pageResult.rowCount > 0) {
        logger.debug(`Deleted page record for page ID ${pageId}`);
      }
    } catch (error) {
      throw new ConnectionError(`Failed to delete page ${pageId}`, error);
    }
  }

  async getPagesByVersionId(versionId: number): Promise<DbPage[]> {
    try {
      const result = await this.pool.query("SELECT * FROM pages WHERE version_id = $1", [
        versionId,
      ]);
      return result.rows;
    } catch (error) {
      throw new ConnectionError("Failed to get pages by version ID", error);
    }
  }

  async removeVersion(
    library: string,
    version: string,
    removeLibraryIfEmpty = true,
  ): Promise<{
    documentsDeleted: number;
    versionDeleted: boolean;
    libraryDeleted: boolean;
  }> {
    try {
      const normalizedLibrary = library.toLowerCase();
      const normalizedVersion = version.toLowerCase();

      const versionResult = await this.pool.query(
        `SELECT v.id, v.library_id FROM versions v
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1 AND COALESCE(v.name, '') = COALESCE($2, '')`,
        [normalizedLibrary, normalizedVersion],
      );

      if (versionResult.rows.length === 0) {
        return { documentsDeleted: 0, versionDeleted: false, libraryDeleted: false };
      }

      const { id: versionId, library_id: libraryId } = versionResult.rows[0];

      const documentsDeleted = await this.deletePages(library, version);

      // Delete pages (already done by deletePages, but ensure)
      await this.pool.query(
        `DELETE FROM pages
         WHERE version_id IN (
           SELECT v.id FROM versions v
           JOIN libraries l ON v.library_id = l.id
           WHERE l.name = $1 AND COALESCE(v.name, '') = COALESCE($2, '')
         )`,
        [normalizedLibrary, normalizedVersion],
      );

      const verDelResult = await this.pool.query("DELETE FROM versions WHERE id = $1", [
        versionId,
      ]);
      const versionDeleted = (verDelResult.rowCount ?? 0) > 0;

      let libraryDeleted = false;
      if (removeLibraryIfEmpty && versionDeleted) {
        const countResult = await this.pool.query(
          "SELECT COUNT(*)::int as count FROM versions WHERE library_id = $1",
          [libraryId],
        );
        const remaining = countResult.rows[0]?.count ?? 0;
        if (remaining === 0) {
          const libDelResult = await this.pool.query(
            "DELETE FROM libraries WHERE id = $1",
            [libraryId],
          );
          libraryDeleted = (libDelResult.rowCount ?? 0) > 0;
        }
      }

      return { documentsDeleted, versionDeleted, libraryDeleted };
    } catch (error) {
      throw new ConnectionError("Failed to remove version", error);
    }
  }

  // ── Document retrieval ─────────────────────────────────────────────

  async getById(id: string): Promise<DbPageChunk | null> {
    try {
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         WHERE d.id = $1`,
        [id],
      );
      if (result.rows.length === 0) return null;
      return this.mapDocRow(result.rows[0]);
    } catch (error) {
      throw new ConnectionError(`Failed to get document by ID ${id}`, error);
    }
  }

  async findByContent(
    library: string,
    version: string,
    query: string,
    limit: number,
  ): Promise<(DbPageChunk & DbChunkRank)[]> {
    try {
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return [];
      }

      const normalizedVersion = version.toLowerCase();

      if (this.isVectorSearchEnabled) {
        // Hybrid search: vector + FTS with RRF ranking
        const rawEmbedding = await this.embeddings.embedQuery(query);
        const embedding = this.padVector(rawEmbedding);
        const overfetchLimit = Math.max(1, limit * this.searchOverfetchFactor);
        const vectorSearchK = overfetchLimit * this.vectorSearchMultiplier;

        const sql = `
          WITH vec_results AS (
            SELECT
              d.id,
              d.embedding <=> $3::vector AS vec_distance
            FROM documents d
            JOIN pages p ON d.page_id = p.id
            JOIN versions v ON p.version_id = v.id
            JOIN libraries l ON v.library_id = l.id
            WHERE l.name = $1
              AND COALESCE(v.name, '') = COALESCE($2, '')
              AND d.embedding IS NOT NULL
            ORDER BY d.embedding <=> $3::vector
            LIMIT $4
          ),
          fts_results AS (
            SELECT
              d.id,
              ts_rank_cd(d.search_vector, websearch_to_tsquery('english', $5)) AS fts_score
            FROM documents d
            JOIN pages p ON d.page_id = p.id
            JOIN versions v ON p.version_id = v.id
            JOIN libraries l ON v.library_id = l.id
            WHERE l.name = $1
              AND COALESCE(v.name, '') = COALESCE($2, '')
              AND d.search_vector @@ websearch_to_tsquery('english', $5)
            ORDER BY fts_score DESC
            LIMIT $6
          )
          SELECT
            d.id::text,
            d.content,
            d.metadata,
            p.url,
            p.title,
            p.content_type,
            d.sort_order,
            d.created_at,
            COALESCE(1.0 / (1.0 + vr.vec_distance), 0) AS vec_score,
            COALESCE(fr.fts_score, 0) AS fts_score
          FROM documents d
          JOIN pages p ON d.page_id = p.id
          LEFT JOIN vec_results vr ON d.id = vr.id
          LEFT JOIN fts_results fr ON d.id = fr.id
          WHERE (vr.id IS NOT NULL OR fr.id IS NOT NULL)
            AND NOT (d.metadata->'types' @> '"structural"')
        `;

        const rawResults = (
          await this.pool.query(sql, [
            library.toLowerCase(),
            normalizedVersion,
            toPgVector(embedding),
            vectorSearchK,
            query,
            overfetchLimit,
          ])
        ).rows;

        // RRF ranking (same algorithm as SQLite implementation)
        const rankedResults = this.assignRanks(rawResults);
        const topResults = rankedResults
          .sort((a, b) => b.rrf_score - a.rrf_score)
          .slice(0, limit);

        return topResults.map((row) => this.mapSearchRow(row));
      }

      // FTS-only fallback
      const ftsResult = await this.pool.query(
        `SELECT
           d.id::text,
           d.content,
           d.metadata,
           p.url,
           p.title,
           p.content_type,
           d.sort_order,
           d.created_at,
           ts_rank_cd(d.search_vector, websearch_to_tsquery('english', $3)) AS fts_score
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND d.search_vector @@ websearch_to_tsquery('english', $3)
           AND NOT (d.metadata->'types' @> '"structural"')
         ORDER BY fts_score DESC
         LIMIT $4`,
        [library.toLowerCase(), normalizedVersion, query, limit],
      );

      return ftsResult.rows.map((row: Record<string, unknown>, index: number) => {
        const chunk = this.mapDocRow(row) as DbPageChunk & DbChunkRank;
        chunk.score = row.fts_score as number;
        (chunk as DbPageChunk & DbChunkRank).fts_rank = index + 1;
        return chunk;
      });
    } catch (error) {
      throw new ConnectionError(
        `Failed to find documents by content with query "${query}"`,
        error,
      );
    }
  }

  async findChildChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const parent = await this.getById(id);
      if (!parent) return [];

      const parentPath = parent.metadata.path ?? [];
      const normalizedVersion = version.toLowerCase();

      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND p.url = $3
           AND jsonb_array_length(d.metadata->'path') = $4
           AND d.metadata->>'path' LIKE $5 || '%'
           AND d.sort_order > (SELECT sort_order FROM documents WHERE id = $6)
         ORDER BY d.sort_order
         LIMIT $7`,
        [
          library.toLowerCase(),
          normalizedVersion,
          parent.url,
          parentPath.length + 1,
          JSON.stringify(parentPath),
          id,
          limit,
        ],
      );
      return result.rows.map((r: Record<string, unknown>) => this.mapDocRow(r));
    } catch (error) {
      throw new ConnectionError(`Failed to find child chunks for ID ${id}`, error);
    }
  }

  async findPrecedingSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const reference = await this.getById(id);
      if (!reference) return [];

      const normalizedVersion = version.toLowerCase();
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND p.url = $3
           AND d.sort_order < (SELECT sort_order FROM documents WHERE id = $4)
           AND d.metadata->>'path' = $5
         ORDER BY d.sort_order DESC
         LIMIT $6`,
        [
          library.toLowerCase(),
          normalizedVersion,
          reference.url,
          id,
          JSON.stringify(reference.metadata.path),
          limit,
        ],
      );
      return result.rows.map((r: Record<string, unknown>) => this.mapDocRow(r)).reverse();
    } catch (error) {
      throw new ConnectionError(
        `Failed to find preceding sibling chunks for ID ${id}`,
        error,
      );
    }
  }

  async findSubsequentSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]> {
    try {
      const reference = await this.getById(id);
      if (!reference) return [];

      const normalizedVersion = version.toLowerCase();
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND p.url = $3
           AND d.sort_order > (SELECT sort_order FROM documents WHERE id = $4)
           AND d.metadata->>'path' = $5
         ORDER BY d.sort_order
         LIMIT $6`,
        [
          library.toLowerCase(),
          normalizedVersion,
          reference.url,
          id,
          JSON.stringify(reference.metadata.path),
          limit,
        ],
      );
      return result.rows.map((r: Record<string, unknown>) => this.mapDocRow(r));
    } catch (error) {
      throw new ConnectionError(
        `Failed to find subsequent sibling chunks for ID ${id}`,
        error,
      );
    }
  }

  async findParentChunk(
    library: string,
    version: string,
    id: string,
  ): Promise<DbPageChunk | null> {
    try {
      const child = await this.getById(id);
      if (!child) return null;

      const path = child.metadata.path ?? [];
      const parentPath = path.slice(0, -1);
      if (parentPath.length === 0) return null;

      const normalizedVersion = version.toLowerCase();
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND p.url = $3
           AND d.metadata->>'path' = $4
           AND d.sort_order < (SELECT sort_order FROM documents WHERE id = $5)
         ORDER BY d.sort_order DESC
         LIMIT 1`,
        [
          library.toLowerCase(),
          normalizedVersion,
          child.url,
          JSON.stringify(parentPath),
          id,
        ],
      );

      if (result.rows.length === 0) return null;
      return this.mapDocRow(result.rows[0]);
    } catch (error) {
      logger.warn(`Failed to find parent chunk for ID ${id}: ${error}`);
      return null;
    }
  }

  async findChunksByIds(
    library: string,
    version: string,
    ids: string[],
  ): Promise<DbPageChunk[]> {
    if (!ids.length) return [];
    try {
      const normalizedVersion = version.toLowerCase();
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND d.id = ANY($3::bigint[])
         ORDER BY d.sort_order`,
        [library.toLowerCase(), normalizedVersion, ids],
      );
      return result.rows.map((r: Record<string, unknown>) => this.mapDocRow(r));
    } catch (error) {
      throw new ConnectionError("Failed to fetch documents by IDs", error);
    }
  }

  async findChunksByUrl(
    library: string,
    version: string,
    url: string,
  ): Promise<DbPageChunk[]> {
    try {
      const normalizedVersion = version.toLowerCase();
      const result = await this.pool.query(
        `SELECT d.id::text, d.page_id, d.content, d.metadata, d.sort_order, d.created_at,
                p.url, p.title, p.content_type
         FROM documents d
         JOIN pages p ON d.page_id = p.id
         JOIN versions v ON p.version_id = v.id
         JOIN libraries l ON v.library_id = l.id
         WHERE l.name = $1
           AND COALESCE(v.name, '') = COALESCE($2, '')
           AND p.url = $3
         ORDER BY d.sort_order`,
        [library.toLowerCase(), normalizedVersion, url],
      );
      return result.rows.map((r: Record<string, unknown>) => this.mapDocRow(r));
    } catch (error) {
      throw new ConnectionError(`Failed to fetch documents by URL ${url}`, error);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private resolveEmbeddingConfig(modelSpec: string): EmbeddingModelConfig | null {
    if (!modelSpec) {
      logger.debug("No embedding model specified. Embeddings are disabled.");
      return null;
    }
    try {
      logger.debug(`Resolving embedding configuration for model: ${modelSpec}`);
      return EmbeddingConfig.parseEmbeddingConfig(modelSpec);
    } catch (error) {
      logger.debug(`Failed to resolve embedding configuration: ${error}`);
      return null;
    }
  }

  private async initializeEmbeddings(): Promise<void> {
    if (this.embeddingConfig === null || this.embeddingConfig === undefined) {
      logger.debug(
        "Embedding initialization skipped (no config provided - FTS-only mode)",
      );
      return;
    }

    const config = this.embeddingConfig;

    if (!areCredentialsAvailable(config.provider)) {
      logger.warn(
        `⚠️  No credentials found for ${config.provider} embedding provider. Vector search is disabled.\n` +
          `   Only full-text search will be available. To enable vector search, please configure the required\n` +
          `   environment variables for ${config.provider} or choose a different provider.`,
      );
      return;
    }

    try {
      this.embeddings = createEmbeddingModel(config.modelSpec, {
        requestTimeoutMs: this.config.embeddings.requestTimeoutMs,
        vectorDimension: this.dbDimension,
      });

      if (config.dimensions !== null) {
        this.modelDimension = config.dimensions;
      } else {
        const testPromise = this.embeddings.embedQuery("test");
        let timeoutId: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Embedding service connection timed out after ${this.embeddingInitTimeoutMs / 1000} seconds`,
              ),
            );
          }, this.embeddingInitTimeoutMs);
        });

        try {
          const testVector = await Promise.race([testPromise, timeoutPromise]);
          this.modelDimension = testVector.length;
        } finally {
          if (timeoutId !== undefined) clearTimeout(timeoutId);
        }

        EmbeddingConfig.setKnownModelDimensions(config.model, this.modelDimension);
      }

      if (this.modelDimension > this.dbDimension) {
        throw new DimensionError(config.modelSpec, this.modelDimension, this.dbDimension);
      }

      this.isVectorSearchEnabled = true;
      logger.debug(
        `Embeddings initialized: ${config.provider}:${config.model} (${this.modelDimension}d)`,
      );
    } catch (error) {
      if (error instanceof Error) {
        if (
          error.message.includes("does not exist") ||
          error.message.includes("MODEL_NOT_FOUND")
        ) {
          throw new ModelConfigurationError(
            `Invalid embedding model: ${config.model}\n` +
              `   The model "${config.model}" is not available or you don't have access to it.`,
          );
        }
        if (
          error.message.includes("API key") ||
          error.message.includes("401") ||
          error.message.includes("authentication")
        ) {
          throw new ModelConfigurationError(
            `Authentication failed for ${config.provider} embedding provider\n` +
              "   Please check your API key configuration.",
          );
        }
        if (
          error.message.includes("timed out") ||
          error.message.includes("ECONNREFUSED") ||
          error.message.includes("ENOTFOUND") ||
          error.message.includes("ETIMEDOUT") ||
          error.message.includes("ECONNRESET") ||
          error.message.includes("network") ||
          error.message.includes("fetch failed")
        ) {
          throw new ModelConfigurationError(
            `Failed to connect to ${config.provider} embedding service\n` +
              `   ${error.message}\n` +
              `   Please check that the embedding service is running and accessible.`,
          );
        }
      }
      throw error;
    }
  }

  private padVector(vector: number[]): number[] {
    if (vector.length > this.dbDimension) {
      throw new Error(
        `Vector dimension ${vector.length} exceeds database dimension ${this.dbDimension}`,
      );
    }
    if (vector.length === this.dbDimension) return vector;
    return [...vector, ...new Array(this.dbDimension - vector.length).fill(0)];
  }

  private isInputSizeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return (
      message.includes("maximum context length") ||
      message.includes("too long") ||
      message.includes("token limit") ||
      message.includes("input is too large") ||
      message.includes("exceeds") ||
      (message.includes("max") && message.includes("token"))
    );
  }

  private async embedDocumentsWithRetry(
    texts: string[],
    isRetry = false,
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      return await this.embeddings.embedDocuments(texts);
    } catch (error) {
      if (this.isInputSizeError(error)) {
        if (texts.length > 1) {
          const midpoint = Math.floor(texts.length / 2);
          if (!isRetry) {
            logger.warn(
              `⚠️  Batch of ${texts.length} texts exceeded size limit, splitting into ${midpoint} + ${texts.length - midpoint}`,
            );
          }
          const [first, second] = await Promise.all([
            this.embedDocumentsWithRetry(texts.slice(0, midpoint), true),
            this.embedDocumentsWithRetry(texts.slice(midpoint), true),
          ]);
          return [...first, ...second];
        }

        const text = texts[0];
        const mid = Math.floor(text.length / 2);
        if (!isRetry) {
          logger.warn(
            `⚠️  Single text exceeded embedding size limit (${text.length} chars).`,
          );
        }
        try {
          return await this.embedDocumentsWithRetry([text.substring(0, mid)], true);
        } catch (retryError) {
          logger.error(
            `❌ Failed to embed even after splitting. Original length: ${text.length}`,
          );
          throw retryError;
        }
      }
      throw error;
    }
  }

  /** Batch embedding with char-based and count-based limits. */
  private async batchEmbed(texts: string[]): Promise<number[][]> {
    const maxBatchChars = this.embeddingBatchChars;
    const rawEmbeddings: number[][] = [];
    let currentBatch: string[] = [];
    let currentBatchSize = 0;
    let batchCount = 0;

    for (const text of texts) {
      const textSize = text.length;

      if (currentBatchSize + textSize > maxBatchChars && currentBatch.length > 0) {
        batchCount++;
        logger.debug(
          `Processing embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
        );
        rawEmbeddings.push(...(await this.embedDocumentsWithRetry(currentBatch)));
        currentBatch = [];
        currentBatchSize = 0;
      }

      currentBatch.push(text);
      currentBatchSize += textSize;

      if (currentBatch.length >= this.embeddingBatchSize) {
        batchCount++;
        logger.debug(
          `Processing embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
        );
        rawEmbeddings.push(...(await this.embedDocumentsWithRetry(currentBatch)));
        currentBatch = [];
        currentBatchSize = 0;
      }
    }

    if (currentBatch.length > 0) {
      batchCount++;
      logger.debug(
        `Processing final embedding batch ${batchCount}: ${currentBatch.length} texts, ${currentBatchSize} chars`,
      );
      rawEmbeddings.push(...(await this.embedDocumentsWithRetry(currentBatch)));
    }

    return rawEmbeddings;
  }

  /** Map a raw PG row to DbPageChunk. Metadata is already parsed by pg driver for JSONB. */
  private mapDocRow(row: Record<string, unknown>): DbPageChunk {
    return {
      id: String(row.id),
      page_id: row.page_id as number,
      content: row.content as string,
      metadata: (typeof row.metadata === "string"
        ? JSON.parse(row.metadata)
        : (row.metadata ?? {})) as DbChunkMetadata,
      sort_order: row.sort_order as number,
      embedding: null, // Don't return raw embeddings
      created_at: String(row.created_at ?? ""),
      score: (row.score as number) ?? null,
      url: (row.url as string) ?? "",
      title: (row.title as string) ?? null,
      content_type: (row.content_type as string) ?? null,
    };
  }

  /** RRF helper – same algorithm as the SQLite store. */
  private calculateRRF(vecRank?: number, ftsRank?: number, k = 60): number {
    let rrf = 0;
    if (vecRank !== undefined) rrf += this.searchWeightVec / (k + vecRank);
    if (ftsRank !== undefined) rrf += this.searchWeightFts / (k + ftsRank);
    return rrf;
  }

  private assignRanks(
    results: Record<string, unknown>[],
  ): Array<Record<string, unknown> & { rrf_score: number }> {
    const vecRanks = new Map<string, number>();
    const ftsRanks = new Map<string, number>();

    results
      .filter((r) => r.vec_score !== undefined && r.vec_score !== null)
      .sort((a, b) => ((b.vec_score as number) ?? 0) - ((a.vec_score as number) ?? 0))
      .forEach((r, i) => {
        vecRanks.set(String(r.id), i + 1);
      });

    results
      .filter((r) => r.fts_score !== undefined && r.fts_score !== null)
      .sort((a, b) => ((b.fts_score as number) ?? 0) - ((a.fts_score as number) ?? 0))
      .forEach((r, i) => {
        ftsRanks.set(String(r.id), i + 1);
      });

    return results.map((r) => ({
      ...r,
      vec_rank: vecRanks.get(String(r.id)),
      fts_rank: ftsRanks.get(String(r.id)),
      rrf_score: this.calculateRRF(
        vecRanks.get(String(r.id)),
        ftsRanks.get(String(r.id)),
      ),
    }));
  }

  private mapSearchRow(
    row: Record<string, unknown> & { rrf_score: number },
  ): DbPageChunk & DbChunkRank {
    const chunk = this.mapDocRow(row);
    return Object.assign(chunk, {
      score: row.rrf_score,
      vec_rank: row.vec_rank as number | undefined,
      fts_rank: row.fts_rank as number | undefined,
    });
  }
}
