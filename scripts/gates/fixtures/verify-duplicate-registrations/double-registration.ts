// Fixture for verify-duplicate-registrations: the violation. `GET
// /api/users` is registered twice in the same file — the first mounted
// match wins and the second registration is silently shadowed.

const router = {
  get(path: string, ...handlers: unknown[]) {
    void path;
    void handlers;
  },
};

router.get('/api/users', () => {});
router.get('/api/users', () => {});
