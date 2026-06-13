// BS-VAL-001 vulnerable fixture: route handlers reading req.body/query/params without Zod
// The handler reads request inputs directly with no schema validation at the boundary.

import express from 'express';

const router = express.Router();

// Vulnerable: reads req.body fields without any Zod .parse() or .safeParse()
router.post('/api/users', (req, res) => {
  const name = req.body.name;
  const email = req.body.email;
  res.json({ created: true, name, email });
});

// Vulnerable: reads req.query without validation
router.get('/api/search', (req, res) => {
  const term = req.query.q;
  res.json({ results: [], term });
});

export default router;
