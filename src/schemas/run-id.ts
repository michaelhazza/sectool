/**
 * Shared RUN_ID_RE constant — single source of truth for the run directory
 * naming pattern. Used in cli.ts (sort/filter) and in the upload traversal
 * guard (C6). A second copy would be a divergence hazard.
 *
 * Pattern: YYYY-MM-DDTHH-MM-SSZ-<4hex>
 */
export const RUN_ID_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z)-[0-9a-f]{4}$/;
