import express from 'express';

const router = express.Router();

// Declare rate limiter middleware (applied inline below)
declare function authLimiter(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void;

// Safe: /login with rate-limit middleware applied before handler
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  res.json({ token: 'example-token', email });
});

// Safe: /register with rate-limit middleware
router.post('/register', authLimiter, async (req, res) => {
  const { email } = req.body as { email: string };
  res.json({ created: true, email });
});

// Safe: unrelated route (products listing — not an auth endpoint)
router.get('/products', async (_req, res) => {
  res.json({ products: [] });
});

export default router;
