// Fixture for verify-duplicate-registrations: two distinct keys, no
// violation. `GET /api/users` and `GET /api/orders` never collide, so this
// fixture has 0 duplicate claims.

const router = {
  get(path: string, ...handlers: unknown[]) {
    void path;
    void handlers;
  },
};

router.get('/api/users', () => {});
router.get('/api/orders', () => {});
