-- Indexes for efficient querying

-- Libraries
CREATE INDEX IF NOT EXISTS idx_libraries_name ON libraries(name);

-- Versions
CREATE INDEX IF NOT EXISTS idx_versions_library_id ON versions(library_id);
CREATE INDEX IF NOT EXISTS idx_versions_status ON versions(status);
CREATE INDEX IF NOT EXISTS idx_versions_source_url ON versions(source_url);

-- Pages
CREATE INDEX IF NOT EXISTS idx_pages_version_id ON pages(version_id);
CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
CREATE INDEX IF NOT EXISTS idx_pages_etag ON pages(etag);

-- Documents
CREATE INDEX IF NOT EXISTS idx_documents_page_id ON documents(page_id);
CREATE INDEX IF NOT EXISTS idx_documents_sort_order ON documents(page_id, sort_order);

-- Vector similarity search index (HNSW for cosine distance)
CREATE INDEX IF NOT EXISTS idx_documents_embedding ON documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
