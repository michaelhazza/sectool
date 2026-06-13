import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'benchmark/**/*.test.ts'],
    // A few tests exercise the fixed-path config loaders (§4.9 mandates fixed,
    // non-overridable loader paths — a security property), so they mutate-and-
    // restore the committed config/ and benchmark/ fixtures. Running test FILES
    // in parallel workers let those writes race with the §4.7 safety-abort test
    // (which reads benchmark/allowlist.benchmark.json), causing intermittent
    // failures. Disable cross-file parallelism so the safety exit-condition test
    // is deterministic. Tests within a file already run sequentially.
    fileParallelism: false,
  },
});
