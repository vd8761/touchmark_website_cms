import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

/**
 * The shared base every workspace extends.
 *
 * Deliberately type-unaware (`tseslint.configs.recommended`, not
 * `recommendedTypeChecked`): a type-aware lint needs a full program per run,
 * which roughly triples CI time for rules the `tsc` step already enforces.
 * What is left is the class of mistake the compiler accepts and a reviewer
 * would not.
 */
export default tseslint.config(
  {
    // Build output and generated clients are not ours to lint.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.d.ts',
      'apps/api/prisma/migrations/**',
      'packages/*/dist/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2023 },
    },
    rules: {
      // An unused parameter is often deliberate (an interface being satisfied);
      // an underscore prefix is how that intent is stated.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // `any` is a real escape hatch in a codebase talking to jsonb and Prisma
      // raw queries. Warn so it stays visible, rather than error so it gets
      // silenced with a disable comment.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-return-await': 'error',
      'prefer-const': 'error',
    },
  },
);
