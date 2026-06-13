import express from 'express';

const router = express.Router();

// Vulnerable: /login without rate-limit middleware
router.post('/login', async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  // credential check would go here
  res.json({ token: 'example-token', email });
});

// Vulnerable: /register without rate-limit middleware
router.post('/register', async (req, res) => {
  const { email } = req.body as { email: string };
  res.json({ created: true, email });
});

// Vulnerable: /api/auth/reset without rate-limit middleware
router.post('/api/auth/reset', async (req, res) => {
  const { email } = req.body as { email: string };
  res.json({ sent: true, email });
});

export default router;
