import base from '../../eslint.config.mjs';

export default [
  ...base,
  {
    files: ['**/*.ts'],
    rules: {
      // NestJS decorators (@Injectable, @Controller) rely on parameter
      // decorators and emitted metadata; empty interfaces and decorator-only
      // constructors are idiomatic here rather than accidental.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Tests reach for `any` when building fixtures and stubbing Prisma; a
    // console line in a test is a debugging aid, not shipped output.
    files: ['test/**/*.ts', '**/*.spec.ts', 'scripts/**/*.ts', 'prisma/seed.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
