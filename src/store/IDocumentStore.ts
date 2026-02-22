import type { ScrapeResult, ScraperOptions } from "../scraper/types";
import type { EmbeddingModelConfig } from "./embeddings/EmbeddingConfig";
import type {
  DbChunkRank,
  DbPage,
  DbPageChunk,
  DbVersion,
  DbVersionWithLibrary,
  StoredScraperOptions,
  VersionStatus,
} from "./types";

/**
 * Abstract interface for document storage backends.
 *
 * Every method returns a `Promise` so that both synchronous (SQLite) and
 * asynchronous (PostgreSQL / Supabase) implementations can conform.
 */
export interface IDocumentStore {
  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Initialise the backing store (run migrations, connect, etc.). */
  initialize(): Promise<void>;

  /** Gracefully release resources (close DB connections, pools, etc.). */
  shutdown(): Promise<void>;

  // ── Embedding configuration ──────────────────────────────────────────

  /**
   * Returns the active embedding configuration if vector search is enabled,
   * or `null` if embeddings are disabled.
   */
  getActiveEmbeddingConfig(): EmbeddingModelConfig | null;

  // ── Library / version resolution ─────────────────────────────────────

  /**
   * Resolves a library name + version string to a `version_id`.
   * Creates library and version records when they don't exist.
   */
  resolveVersionId(library: string, version: string): Promise<number>;

  /** Retrieves all unique versions for a given library. */
  queryUniqueVersions(library: string): Promise<string[]>;

  /** Retrieves a mapping of all libraries → version details. */
  queryLibraryVersions(): Promise<
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
  >;

  /** Checks whether any documents exist for a library/version pair. */
  checkDocumentExists(library: string, version: string): Promise<boolean>;

  // ── Version CRUD ─────────────────────────────────────────────────────

  getVersionById(versionId: number): Promise<DbVersion | null>;
  getVersionsByStatus(statuses: VersionStatus[]): Promise<DbVersionWithLibrary[]>;
  updateVersionStatus(
    versionId: number,
    status: VersionStatus,
    errorMessage?: string,
  ): Promise<void>;
  updateVersionProgress(
    versionId: number,
    pages: number,
    maxPages: number,
  ): Promise<void>;

  // ── Library CRUD ─────────────────────────────────────────────────────

  getLibraryById(libraryId: number): Promise<{ id: number; name: string } | null>;
  getLibrary(name: string): Promise<{ id: number; name: string } | null>;
  deleteLibrary(libraryId: number): Promise<void>;

  // ── Scraper options ──────────────────────────────────────────────────

  storeScraperOptions(versionId: number, options: ScraperOptions): Promise<void>;
  getScraperOptions(versionId: number): Promise<StoredScraperOptions | null>;
  findVersionsBySourceUrl(url: string): Promise<DbVersionWithLibrary[]>;

  // ── Document CRUD ────────────────────────────────────────────────────

  addDocuments(
    library: string,
    version: string,
    depth: number,
    result: ScrapeResult,
  ): Promise<void>;

  deletePages(library: string, version: string): Promise<number>;
  deletePage(pageId: number): Promise<void>;
  getPagesByVersionId(versionId: number): Promise<DbPage[]>;

  removeVersion(
    library: string,
    version: string,
    removeLibraryIfEmpty?: boolean,
  ): Promise<{
    documentsDeleted: number;
    versionDeleted: boolean;
    libraryDeleted: boolean;
  }>;

  // ── Document retrieval ───────────────────────────────────────────────

  getById(id: string): Promise<DbPageChunk | null>;

  findByContent(
    library: string,
    version: string,
    query: string,
    limit: number,
  ): Promise<(DbPageChunk & DbChunkRank)[]>;

  findChildChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;

  findPrecedingSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;

  findSubsequentSiblingChunks(
    library: string,
    version: string,
    id: string,
    limit: number,
  ): Promise<DbPageChunk[]>;

  findParentChunk(
    library: string,
    version: string,
    id: string,
  ): Promise<DbPageChunk | null>;

  findChunksByIds(
    library: string,
    version: string,
    ids: string[],
  ): Promise<DbPageChunk[]>;

  findChunksByUrl(library: string, version: string, url: string): Promise<DbPageChunk[]>;
}
