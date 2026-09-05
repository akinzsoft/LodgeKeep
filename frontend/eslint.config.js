/**
 * ESLint — frontend. Two jobs: normal React code quality (via
 * eslint-plugin-react/react-hooks), and TESTING.md FE-2's design-token rule —
 * "no literal hex or currency symbol outside tokens.css" — made real rather
 * than aspirational, the same way the backend's eslint.config.js enforces the
 * scoped-accessor rule instead of just documenting it.
 *
 * The CSS half of FE-2 (no hex outside tokens.css in .css files) is
 * stylelint's job (stylelint.config.js). This file covers the JS/JSX half:
 * no hex literal in an inline style or JS value, and no hardcoded currency
 * symbol — money always renders through `src/shared/format/money.jsx`, which
 * derives the symbol from the amount's own currency code (ARCHITECTURE.md
 * §1, §12), never a symbol picked by the component that happens to display
 * it.
 */

import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

const HEX_COLOR = String.raw`/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/`;
// A representative set, not exhaustive — every symbol PRODUCT_REQUIREMENTS.md's
// currency list implies (NGN/GBP/USD/EUR at minimum, from the fixtures'
// property currencies) plus the common ones a tenant elsewhere might use.
const CURRENCY_SYMBOL = String.raw`/[$€£¥₦₹₩₽]/`;

const hexColorRestriction = {
  selector: `Literal[value=${HEX_COLOR}]`,
  message:
    'No literal hex colors in component files (DESIGN_SYSTEM.md §1, TESTING.md FE-2) — use a CSS ' +
    'custom property from src/styles/tokens.css via a class name instead. A hardcoded hex is invisible ' +
    "to tenant theming (DESIGN_SYSTEM.md §1's \"tenant theming\" note) and to the next design change.",
};

const CURRENCY_MESSAGE =
  'No literal currency symbols in component files (ARCHITECTURE.md §1/§12, TESTING.md FE-2) — every ' +
  'money value carries its own currency code; render it through src/shared/format/money.jsx, which ' +
  'derives the symbol from that code. A hardcoded symbol is wrong the moment a tenant bills in a ' +
  'different currency.';

// Two selectors, not one: a currency symbol in code is a `Literal` ('$' + a
// JS expression), but the far more common case in JSX — `<span>$42.00</span>`
// — is raw `JSXText`, a different AST node ESLint's `Literal` selector does
// not match at all. Missing the second one would mean this rule catches
// almost nothing a component actually writes.
const currencySymbolRestrictions = [
  { selector: `Literal[value=${CURRENCY_SYMBOL}]`, message: CURRENCY_MESSAGE },
  { selector: `JSXText[value=${CURRENCY_SYMBOL}]`, message: CURRENCY_MESSAGE },
];

export default [
  { ignores: ['node_modules/**', 'dist/**', 'coverage/**'] },

  js.configs.recommended,

  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        localStorage: 'readonly',
        navigator: 'readonly',
        Event: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
      },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: '19.2' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs['recommended-latest'].rules,
      'react/react-in-jsx-scope': 'off', // the automatic JSX runtime needs no import
      'react/prop-types': 'off', // no PropTypes convention adopted; JSDoc on each component instead
      'no-restricted-syntax': ['error', hexColorRestriction, ...currencySymbolRestrictions],
    },
  },

  {
    // The one legitimate exception: this file's whole job is asserting which
    // literal symbol formatMoney produces for a given currency code — using
    // formatMoney to build its own expected value would make the test
    // circular. Every other test file that needs a money-shaped example
    // value builds it via formatMoney() instead (see DataTable's tests).
    files: ['src/shared/format/__tests__/money.test.jsx'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    files: ['**/*.test.{js,jsx}', 'tests/**/*.{js,jsx}'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        vi: 'readonly',
      },
    },
  },
];
