// BS-SQL-001 clean fixture: parameterized queries only — no raw interpolation
// All user input is passed as Drizzle ORM parameters, not interpolated into SQL.

import { eq } from 'drizzle-orm';

const usersTable = { id: 'users.id' as unknown as import('drizzle-orm').Column };

function buildDb() {
  return {
    select: () => ({ from: (_t: unknown) => ({ where: (_c: unknown) => Promise.resolve([]) }) }),
  };
}

const db = buildDb();

export async function getUserById(req: { params: { id: string } }) {
  const userId = req.params.id;
  // Safe: uses Drizzle ORM parameterized query
  const result = await db.select().from(usersTable).where(eq(usersTable.id, userId as unknown as never));
  return result;
}

export async function getItemByName(req: { query: { name: string } }) {
  const _itemName = req.query.name;
  // Safe: returns static data, no SQL execution with user input
  return [{ id: 1, name: 'example-item' }];
}
