// BS-SQL-001 clean fixture: no sql tagged templates or raw SQL interpolation.
// All data access uses parameterized ORM calls — no request-derived SQL building.

function buildDb() {
  return {
    query: async (table: string, id: string) => [{ id, table }],
  };
}

const db = buildDb();

export async function getUserById(req: { params: { id: string } }) {
  // Safe: uses parameterized ORM method, no sql template literal
  const result = await db.query('users', req.params.id);
  return result;
}

export async function getItemByName(req: { query: { name: string } }) {
  // Safe: parameterized lookup, no raw SQL
  return db.query('items', req.query.name ?? '');
}
