// Semgrep clean fixture — parameterized query, no injection surface.
import type { Request, Response } from 'express';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function safeQuery(req: Request, res: Response, db: any): void {
  const id = req.params['id'];
  // Safe: parameterized query
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
  db.execute('SELECT * FROM users WHERE id = $1', [id])
    .then((rows: unknown) => res.json(rows))
    .catch(() => res.status(500).end());
}
