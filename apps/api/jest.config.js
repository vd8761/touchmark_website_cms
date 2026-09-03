module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testEnvironment: 'node',
  testRegex: '\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  // @cms/shared resolves through the workspace symlink to its built dist, the
  // same way the compiled API resolves it. Run `npm run build --workspace
  // @cms/shared` first (CI does this before any test step).
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
  testTimeout: 30000,
  // Removes the tenants the e2e suites create. Without it they accumulate in
  // whatever database the suite last ran against — see test/global-teardown.ts.
  // Set SKIP_E2E_TEARDOWN=true to keep them for debugging a failure.
  globalTeardown: '<rootDir>/test/global-teardown.ts',
};
