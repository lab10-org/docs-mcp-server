import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integration tests for SupabaseDocumentStore.
 *
 * These tests require a real Supabase/PostgreSQL instance.
 * They are skipped by default unless the SUPABASE_TEST_URL environment variable is set.
 *
 * To run:
 *   SUPABASE_TEST_URL=postgresql://... npm test -- src/store/SupabaseDocumentStore.integration.test.ts
 */

const SKIP = !process.env.SUPABASE_TEST_URL;

describe.skipIf(SKIP)("SupabaseDocumentStore (integration)", () => {
  // Dynamic import because pg may not be installed in all environments
  let SupabaseDocumentStore: any;
  let store: any;

  beforeAll(async () => {
    const mod = await import("./SupabaseDocumentStore");
    SupabaseDocumentStore = mod.SupabaseDocumentStore;

    const { loadConfig } = await import("../utils/config");
    const config = loadConfig();
    config.storage.provider = "supabase";
    config.storage.supabase.connectionString = process.env.SUPABASE_TEST_URL!;

    store = new SupabaseDocumentStore(config);
    await store.initialize();
  });

  afterAll(async () => {
    if (store) {
      await store.shutdown();
    }
  });

  it("should initialize the store", () => {
    expect(store).toBeDefined();
  });

  it("should resolve a version id", async () => {
    const versionId = await store.resolveVersionId("integration-test-lib", "0.0.1");
    expect(typeof versionId).toBe("number");
    expect(versionId).toBeGreaterThan(0);
  });

  it("should check document existence", async () => {
    const exists = await store.checkDocumentExists("integration-test-lib", "0.0.1");
    // No documents added yet
    expect(exists).toBe(false);
  });

  it("should clean up test data", async () => {
    const result = await store.removeVersion("integration-test-lib", "0.0.1", true);
    expect(result.versionDeleted).toBe(true);
    expect(result.libraryDeleted).toBe(true);
  });
});
