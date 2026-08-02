// Fixture for verify-factory-invocation: the violation. `requireRole` is a
// FACTORY (its top-level body returns a function literal) but is passed BARE
// to the registration call — the check it would have built never runs at
// request time.

export function requireRole(role: string) {
  return (req: unknown, res: unknown, next: () => void) => {
    if (role) next();
  };
}

const router = {
  get(path: string, ...handlers: unknown[]) {
    void path;
    void handlers;
  },
};

router.get('/bad', requireRole, () => {});
