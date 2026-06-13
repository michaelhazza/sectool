// BS-AUTH-001 vulnerable fixture: Express routes without auth middleware
// These routes access sensitive data but have no auth/permission middleware.

import express from 'express';

const router = express.Router();

// Vulnerable: no auth middleware before handler
router.get('/api/users', (req, res) => {
  res.json({ users: [] });
});

// Vulnerable: no auth middleware before handler
router.post('/api/admin/settings', (req, res) => {
  res.json({ updated: true });
});

// Vulnerable: two args only (path + handler), no middleware
router.delete('/api/users/:id', (req, res) => {
  res.json({ deleted: req.params['id'] });
});

export default router;
