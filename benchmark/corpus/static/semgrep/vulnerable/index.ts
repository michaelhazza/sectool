// Semgrep vulnerable fixture — intentional injection pattern for semgrep recall test.
// INTENTIONALLY VULNERABLE: user input interpolated directly into SQL query.
import type { Request, Response } from 'express';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unsafeQuery(req: Request, res: Response, db: any): void {
  const id = req.params['id'];
  // INTENTIONALLY VULNERABLE: SQL injection
  const query = `SELECT * FROM users WHERE id = ${id}`;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  db.execute(query).then((rows: unknown) => res.json(rows)).catch(() => res.status(500).end());
}
