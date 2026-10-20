export default [
  {
    ignores: ['app.js', 'worker/**', 'android/**', 'www/**', 'dist/**'],
  },
  {
    // The legacy runtime isn't fully lint-clean yet; guard the bug class that
    // crashed Payroll: a local `state` shadowing the app's global state.
    files: ['src/runtime/legacy.js', 'src/runtime/filing-overrides.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: {
      'no-restricted-syntax': ['error', {
        selector: ":function VariableDeclarator[id.name='state'], :function > Identifier.params[name='state'], CatchClause > Identifier.param[name='state']",
        message: "Don't declare a local `state`: it shadows the app's global state (this crashed Payroll). Use a specific name such as stateTax.",
      }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['src/main.js', 'src/shared/**/*.js', 'src/modules/**/*.js', 'src/runtime/home.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        queueMicrotask: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        URLSearchParams: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        indexedDB: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.test.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        structuredClone: 'readonly',
        crypto: 'readonly',
        Buffer: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
];
