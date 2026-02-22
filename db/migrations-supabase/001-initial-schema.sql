-- Initial schema for Supabase/PostgreSQL storage provider.
-- Mirrors the final state of the SQLite migrations (000–011).

-- Libraries table
CREATE TABLE IF NOT EXISTS libraries (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

-- Versions table
CREATE TABLE IF NOT EXISTS versions (
  id SERIAL PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id),
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_indexed',
  progress_pages INTEGER NOT NULL DEFAULT 0,
  progress_max_pages INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  source_url TEXT,
  scraper_options TEXT,  -- JSON string of VersionScraperOptions
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(library_id, name)
);

-- Pages table
CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES versions(id),
  url TEXT NOT NULL,
  title TEXT,
  etag TEXT,
  last_modified TEXT,
  content_type TEXT,
  depth INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(version_id, url)
);

-- Documents (chunks) table
CREATE TABLE IF NOT EXISTS documents (
  id BIGSERIAL PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES pages(id),
  content TEXT,
  metadata JSONB,  -- Chunk-specific metadata (level, path, types)
  sort_order INTEGER NOT NULL,
  embedding vector(1536),  -- Native pgvector type
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
