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
    // The config-git / config-write / static-clone integration tests shell out to
    // real `git` (a single test can spawn ~30 clone/fetch/commit/push processes
    // against a local bare repo). On a loaded machine — especially Windows, where
    // process spawn + AV scanning is slower — that legitimately exceeds the 5s
    // default and times out spuriously. 30s gives real-git work headroom while
    // still bounding a genuine hang. (Teardown rmdir also retries on Windows
    // EBUSY; see the maxRetries in those tests' afterEach.)
    testTimeout: 30_000,
  },
});
