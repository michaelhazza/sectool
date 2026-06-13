-- Initial migration: creates tables without RLS policies
-- Note: subscriptions and users tables have organisation_id but no RLS policy

CREATE TABLE subscriptions (
  id SERIAL PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  plan TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);
