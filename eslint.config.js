import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // migrations/ and scripts/ are framework-managed files deployed by
    // .claude-framework/sync.js — they lint under the framework's own config.
    ignores: [
      'dist/**',
      'node_modules/**',
      '.claude-framework/**',
      'coverage/**',
      'migrations/**',
      'scripts/**',
      // benchmark corpus + live fixtures are intentionally-vulnerable target-app
      // code samples, not tool source — they are scanned, not linted/type-checked.
      'benchmark/corpus/**',
      'benchmark/live-fixture/**',
      // the React SPA builds + type-checks under its own ui/tsconfig.json + Vite;
      // it is not part of the main `eslint .` / `tsc --noEmit` project.
      'ui/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
