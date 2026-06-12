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
