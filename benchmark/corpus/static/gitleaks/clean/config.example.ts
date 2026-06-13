// Gitleaks clean fixture — no hardcoded secrets.

// Safe: reads from environment variable, never hardcoded.
export const API_KEY = process.env['API_KEY'] ?? '';
