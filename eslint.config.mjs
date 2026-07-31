// @ts-check
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// import.meta.dirname needs Node 20.11; this repo still builds on Node 18.
const rootDir = dirname(fileURLToPath(import.meta.url));

// Exists in Node, missing on a phone.
const MOBILE_UNSAFE_GLOBALS = [
  { name: 'fetch', message: 'CORS-blocked in Obsidian. Use requestUrl from obsidian.' },
  { name: 'Buffer', message: 'Not available on Obsidian mobile. Use Uint8Array.' },
  { name: 'process', message: 'Not available on Obsidian mobile.' },
  { name: '__dirname', message: 'Not available on Obsidian mobile.' },
  { name: 'require', message: 'Not available on Obsidian mobile.' },
];

const MOBILE_UNSAFE_IMPORT_PATTERNS = [
  {
    group: ['fs', 'path', 'crypto', 'os', 'node:*'],
    message: 'Node builtins are unavailable on Obsidian mobile.',
  },
  { group: ['**/index'], message: 'No barrel imports.' },
];

export default tseslint.config(
  {
    ignores: ['main.js', 'main.js.map', 'coverage/**', 'dist/**'],
  },

  js.configs.recommended,

  // TypeScript, type-aware. projectService picks the nearest tsconfig.json:
  // the root one for src/, test/tsconfig.json for tests.
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      // Obsidian command callbacks are synchronous. An unawaited push() fails
      // silently and the user thinks the vault is backed up.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',

      // Forces a real type guard on every Drive response instead of `as Dto`.
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-declaration-merging': 'error',
      '@typescript-eslint/no-unsafe-enum-comparison': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',

      'no-restricted-globals': ['error', ...MOBILE_UNSAFE_GLOBALS],
      'no-restricted-imports': ['error', { patterns: MOBILE_UNSAFE_IMPORT_PATTERNS }],
    },
  },

  // src/core/ stays pure so it can be tested without booting Obsidian.
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'obsidian',
              message: 'src/core must stay pure and testable. Inject I/O instead.',
            },
          ],
          patterns: MOBILE_UNSAFE_IMPORT_PATTERNS,
        },
      ],
    },
  },

  // Tests are Node. Buffer and node: imports are fine here.
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // Build scripts and CLI tools. Checked by tsc -p tools/tsconfig.json instead.
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },

  // Must stay last: turns off rules that fight Prettier.
  eslintConfigPrettier,
);
