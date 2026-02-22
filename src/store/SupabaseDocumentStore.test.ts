import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../utils/config";
import type { IDocumentStore } from "./IDocumentStore";

// Mock the pg module since we don't have a real Postgres DB in unit tests
const mockClient = {
  query: vi.fn(),
  release: vi.fn(),
};

const mockPool = {
  query: vi.fn(),
  connect: vi.fn().mockResolvedValue(mockClient),
  end: vi.fn(),
  on: vi.fn(),
};

vi.mock("pg", () => ({
  default: { Pool: vi.fn(() => mockPool) },
  Pool: vi.fn(() => mockPool),
}));

// Mock the migration runner
vi.mock("./applyMigrationsPostgres", () => ({
  applyMigrationsPostgres: vi.fn(),
}));

// Mock embedding factory to disable vector search in tests
vi.mock("./embeddings/EmbeddingFactory", () => ({
  areCredentialsAvailable: vi.fn().mockReturnValue(false),
  createEmbeddingModel: vi.fn(),
  ModelConfigurationError: class extends Error {},
  UnsupportedProviderError: class extends Error {},
}));

describe("SupabaseDocumentStore", () => {
  let store: IDocumentStore;
  let appConfig: ReturnType<typeof loadConfig>;

  beforeEach(async () => {
    vi.clearAllMocks();

    appConfig = loadConfig();
    appConfig.storage.provider = "supabase";
    appConfig.storage.supabase.connectionString =
      "postgresql://test:test@localhost:5432/test";
    appConfig.app.embeddingModel = "";

    // Reset mock pool behaviour
    mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockPool.connect.mockResolvedValue(mockClient);
    mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

    // Dynamically import after mocks are set up
    const { SupabaseDocumentStore } = await import("./SupabaseDocumentStore");
    store = new SupabaseDocumentStore(appConfig);
    await store.initialize();
  });

  describe("lifecycle", () => {
    it("should initialize without errors", () => {
      expect(store).toBeDefined();
    });

    it("should shut down cleanly", async () => {
      await store.shutdown();
      expect(mockPool.end).toHaveBeenCalled();
    });
  });

  describe("getActiveEmbeddingConfig", () => {
    it("should return null when embeddings are disabled", () => {
      expect(store.getActiveEmbeddingConfig()).toBeNull();
    });
  });

  describe("resolveVersionId", () => {
    it("should create library and version and return version id", async () => {
      mockPool.query
        // INSERT library
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // SELECT library id
        .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 })
        // INSERT version
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        // SELECT version id
        .mockResolvedValueOnce({ rows: [{ id: 42 }], rowCount: 1 });

      const versionId = await store.resolveVersionId("my-lib", "1.0.0");
      expect(versionId).toBe(42);
    });
  });

  describe("queryUniqueVersions", () => {
    it("should return normalized version names", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ name: "1.0.0" }, { name: null }, { name: "2.0.0" }],
        rowCount: 3,
      });

      const versions = await store.queryUniqueVersions("my-lib");
      expect(versions).toEqual(["1.0.0", "", "2.0.0"]);
    });
  });

  describe("checkDocumentExists", () => {
    it("should return true when documents exist", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [{ id: 1 }],
        rowCount: 1,
      });

      const exists = await store.checkDocumentExists("my-lib", "1.0.0");
      expect(exists).toBe(true);
    });

    it("should return false when no documents exist", async () => {
      mockPool.query.mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });

      const exists = await store.checkDocumentExists("my-lib", "1.0.0");
      expect(exists).toBe(false);
    });
  });

  describe("getVersionById", () => {
    it("should return version when found", async () => {
      const mockVersion = { id: 1, library_id: 1, name: "1.0.0", status: "completed" };
      mockPool.query.mockResolvedValueOnce({ rows: [mockVersion], rowCount: 1 });

      const version = await store.getVersionById(1);
      expect(version).toEqual(mockVersion);
    });

    it("should return null when not found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const version = await store.getVersionById(999);
      expect(version).toBeNull();
    });
  });

  describe("getLibrary", () => {
    it("should return library when found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

      const lib = await store.getLibrary("my-lib");
      expect(lib).toEqual({ id: 1, name: "my-lib" });
    });

    it("should return null when not found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const lib = await store.getLibrary("nonexistent");
      expect(lib).toBeNull();
    });
  });

  describe("getById", () => {
    it("should return document when found", async () => {
      const mockRow = {
        id: "1",
        page_id: 10,
        content: "Hello world",
        metadata: { path: ["section"] },
        sort_order: 0,
        created_at: "2024-01-01",
        url: "https://example.com",
        title: "Test",
        content_type: "text/html",
      };
      mockPool.query.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const doc = await store.getById("1");
      expect(doc).toBeTruthy();
      expect(doc?.content).toBe("Hello world");
      expect(doc?.url).toBe("https://example.com");
    });

    it("should return null when not found", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const doc = await store.getById("999");
      expect(doc).toBeNull();
    });
  });

  describe("deletePages", () => {
    it("should return count of deleted documents", async () => {
      // Delete documents query
      mockPool.query
        .mockResolvedValueOnce({ rows: [], rowCount: 5 })
        // Delete pages query
        .mockResolvedValueOnce({ rows: [], rowCount: 2 });

      const count = await store.deletePages("my-lib", "1.0.0");
      expect(count).toBe(5);
    });
  });

  describe("removeVersion", () => {
    it("should return zero counts when version does not exist", async () => {
      mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await store.removeVersion("my-lib", "1.0.0");
      expect(result).toEqual({
        documentsDeleted: 0,
        versionDeleted: false,
        libraryDeleted: false,
      });
    });
  });

  describe("schema configuration", () => {
    it("should set search_path and create schema when schema is configured", async () => {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      mockPool.connect.mockResolvedValue(mockClient);
      mockPool.on.mockImplementation(() => {});
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const schemaConfig = loadConfig();
      schemaConfig.storage.provider = "supabase";
      schemaConfig.storage.supabase.connectionString =
        "postgresql://test:test@localhost:5432/test";
      schemaConfig.storage.supabase.schema = "my_schema";
      schemaConfig.app.embeddingModel = "";

      const { SupabaseDocumentStore } = await import("./SupabaseDocumentStore");
      const schemaStore = new SupabaseDocumentStore(schemaConfig);
      await schemaStore.initialize();

      // Verify pool.on('connect') was registered
      expect(mockPool.on).toHaveBeenCalledWith("connect", expect.any(Function));

      // Verify CREATE SCHEMA was called
      expect(mockClient.query).toHaveBeenCalledWith(
        "CREATE SCHEMA IF NOT EXISTS my_schema",
      );

      // Verify SET search_path was called on the schema client
      expect(mockClient.query).toHaveBeenCalledWith(
        "SET search_path TO my_schema, public",
      );
    });

    it("should not set search_path when schema is empty", async () => {
      // The default beforeEach uses empty schema, so just verify no schema calls
      expect(mockPool.on).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalledWith(
        expect.stringContaining("CREATE SCHEMA"),
      );
    });

    it("should reject invalid schema names", async () => {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      mockPool.connect.mockResolvedValue(mockClient);
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      const badConfig = loadConfig();
      badConfig.storage.provider = "supabase";
      badConfig.storage.supabase.connectionString =
        "postgresql://test:test@localhost:5432/test";
      badConfig.storage.supabase.schema = "my;DROP TABLE";
      badConfig.app.embeddingModel = "";

      const { SupabaseDocumentStore } = await import("./SupabaseDocumentStore");
      const badStore = new SupabaseDocumentStore(badConfig);
      await expect(badStore.initialize()).rejects.toThrow(
        "Invalid PostgreSQL schema name",
      );
    });

    it("should invoke the on-connect handler with SET search_path", async () => {
      vi.clearAllMocks();
      mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
      mockPool.connect.mockResolvedValue(mockClient);
      mockClient.query.mockResolvedValue({ rows: [], rowCount: 0 });

      let connectHandler: ((client: unknown) => void) | undefined;
      mockPool.on.mockImplementation(
        (event: string, handler: (client: unknown) => void) => {
          if (event === "connect") connectHandler = handler;
        },
      );

      const schemaConfig = loadConfig();
      schemaConfig.storage.provider = "supabase";
      schemaConfig.storage.supabase.connectionString =
        "postgresql://test:test@localhost:5432/test";
      schemaConfig.storage.supabase.schema = "docs_prod";
      schemaConfig.app.embeddingModel = "";

      const { SupabaseDocumentStore } = await import("./SupabaseDocumentStore");
      const schemaStore = new SupabaseDocumentStore(schemaConfig);
      await schemaStore.initialize();

      // Simulate a new connection
      expect(connectHandler).toBeDefined();
      const fakeClient = { query: vi.fn() };
      connectHandler!(fakeClient);
      expect(fakeClient.query).toHaveBeenCalledWith(
        "SET search_path TO docs_prod, public",
      );
    });
  });

  describe("findByContent (FTS-only)", () => {
    it("should return empty array for empty query", async () => {
      const results = await store.findByContent("my-lib", "1.0.0", "", 10);
      expect(results).toEqual([]);
    });

    it("should return empty array for whitespace-only query", async () => {
      const results = await store.findByContent("my-lib", "1.0.0", "   ", 10);
      expect(results).toEqual([]);
    });

    it("should return FTS results when query is valid", async () => {
      const mockRows = [
        {
          id: "1",
          content: "Test content",
          metadata: { path: ["section"] },
          url: "https://example.com",
          title: "Test",
          content_type: "text/html",
          sort_order: 0,
          created_at: "2024-01-01",
          fts_score: 0.5,
        },
      ];
      mockPool.query.mockResolvedValueOnce({ rows: mockRows, rowCount: 1 });

      const results = await store.findByContent("my-lib", "1.0.0", "test", 10);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe("Test content");
    });
  });
});
