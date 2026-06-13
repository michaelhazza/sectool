// BS-SQL-001 vulnerable fixture: SQL injection via request-derived interpolation
// This file intentionally contains a security vulnerability for testing purposes.
// The user ID value flows from req.params into a sql tagged template literal.

import { sql } from 'drizzle-orm';

function buildDb() {
  return {
    execute: async (query: unknown) => query,
  };
}

const db = buildDb();

export async function getUserById(req: { params: { id: string } }) {
  const userId = req.params.id;
  // Vulnerable: direct interpolation of request param into SQL template
  const result = await db.execute(sql`SELECT * FROM users WHERE id = ${userId}`);
  return result;
}

export async function getItemByName(req: { query: { name: string } }) {
  const itemName = req.query.name;
  // Vulnerable: direct interpolation of query param into sql tagged template
  const rows = await db.execute(sql`SELECT * FROM items WHERE name = ${itemName}`);
  return rows;
}
