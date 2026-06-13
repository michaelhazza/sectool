// BS-AUTH-001 clean fixture: Express routes with proper auth middleware
// All protected routes have auth middleware; public routes are in publicRoutes config.

import express from 'express';

const router = express.Router();

function requireAuth(req: unknown, res: unknown, next: () => void) {
  next();
}

function requireAdmin(req: unknown, res: unknown, next: () => void) {
  next();
}

// Safe: auth middleware present before handler
router.get('/api/users', requireAuth, (req, res) => {
  res.json({ users: [] });
});

// Safe: admin guard present
router.post('/api/admin/settings', requireAuth, requireAdmin, (req, res) => {
  res.json({ updated: true });
});

// Safe: auth guard present
router.delete('/api/users/:id', requireAuth, (req, res) => {
  res.json({ deleted: true });
});

// This route is public (POST /api/auth/login in publicRoutes config) — would be skipped
router.post('/api/auth/login', (req, res) => {
  res.json({ token: 'example-token-value' });
});

export default router;
