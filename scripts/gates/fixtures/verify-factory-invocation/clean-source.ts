// Fixture for verify-factory-invocation: correct usage, no violation.
// `requireRole` is a FACTORY (its top-level body returns a function literal)
// and is correctly INVOKED (`requireRole('admin')`) before being handed to
// the registration call — the check it builds runs at request time.

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

router.get('/ok', requireRole('admin'), () => {});
