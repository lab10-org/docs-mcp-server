-- Full-text search support using tsvector

-- Add search_vector column to documents
ALTER TABLE documents ADD COLUMN IF NOT EXISTS search_vector tsvector;

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS idx_documents_search_vector
  ON documents USING gin(search_vector);

-- Function to build the search_vector from document content and page metadata
CREATE OR REPLACE FUNCTION documents_search_vector_update() RETURNS trigger AS $$
DECLARE
  page_title TEXT;
  page_url TEXT;
  doc_path TEXT;
BEGIN
  -- Look up page-level fields
  SELECT p.title, p.url INTO page_title, page_url
  FROM pages p WHERE p.id = NEW.page_id;

  -- Extract path from JSONB metadata
  doc_path := array_to_string(
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(NEW.metadata->'path', '[]'::jsonb))),
    ' '
  );

  -- Build weighted tsvector:
  --   A = title (highest weight), B = path, C = url, D = content
  NEW.search_vector :=
    setweight(to_tsvector('english', COALESCE(page_title, '')), 'A') ||
    setweight(to_tsvector('english', COALESCE(doc_path, '')), 'B') ||
    setweight(to_tsvector('english', COALESCE(page_url, '')), 'C') ||
    setweight(to_tsvector('english', COALESCE(NEW.content, '')), 'D');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to automatically maintain search_vector on insert/update
DROP TRIGGER IF EXISTS trg_documents_search_vector ON documents;
CREATE TRIGGER trg_documents_search_vector
  BEFORE INSERT OR UPDATE ON documents
  FOR EACH ROW
  EXECUTE FUNCTION documents_search_vector_update();

-- Backfill search_vector for any existing rows
UPDATE documents SET search_vector = search_vector;
