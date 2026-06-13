// BS-VAL-001 clean fixture: route handlers with Zod schema validation at the boundary

import express from 'express';
import { z } from 'zod';

const router = express.Router();

const CreateUserSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
});

const SearchSchema = z.object({
  q: z.string().min(1).max(200),
});

// Safe: body parsed and validated with Zod before use
router.post('/api/users', (req, res) => {
  const parsed = CreateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input' });
    return;
  }
  const { name, email } = parsed.data;
  res.json({ created: true, name, email });
});

// Safe: query parsed with Zod
router.get('/api/search', (req, res) => {
  const parsed = SearchSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query' });
    return;
  }
  res.json({ results: [], term: parsed.data.q });
});

export default router;
