-- Migration with RLS policy for the documents table
-- This satisfies BS-RLS-001 — the tenant table has a corresponding RLS policy.

CREATE TABLE documents (
  id SERIAL PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE global_config (
  id SERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT
);

-- RLS policy for documents: each org can only see its own rows
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY documents_org_isolation ON documents
  USING (organisation_id = current_setting('app.current_org_id'));
