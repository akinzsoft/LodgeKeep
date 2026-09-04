/**
 * stylelint — the CSS half of TESTING.md FE-2 ("no literal hex ... outside
 * tokens.css"). `color-no-hex` is a stylelint core rule; the override below
 * is the one place it is allowed to fire the other way — `tokens.css` is
 * where a hex value is the definition, not a shortcut around one.
 */
export default {
  extends: ['stylelint-config-standard'],
  rules: {
    'color-no-hex': [
      true,
      {
        message:
          'No literal hex colors outside src/styles/tokens.css (DESIGN_SYSTEM.md §1, TESTING.md FE-2) — ' +
          'use a var(--token) custom property instead.',
      },
    ],
    // Custom properties are the whole point of this file; standard's
    // pattern rule otherwise complains about kebab-case tokens like
    // --state-success-bg for not being camelCase.
    'custom-property-pattern': null,
    // Purely stylistic preferences from stylelint-config-standard that would
    // otherwise silently rewrite DESIGN_SYSTEM.md §1's literal token values
    // (it specifies `#FFFFFF` and `rgba(28,36,52,0.06)` verbatim) — none of
    // these are what TESTING.md FE-2 actually requires, which is `color-no-hex`
    // above. Blank lines between custom properties are kept for grouping.
    'color-hex-length': null,
    'color-function-notation': null,
    'color-function-alias-notation': null,
    'alpha-value-notation': null,
    'custom-property-empty-line-before': null,
    // CSS Modules convention: class names are camelCase so `styles.fooBar`
    // works directly in JS without bracket access. kebab-case is the
    // convention for global stylesheets, not modules.
    'selector-class-pattern': null,
  },
  overrides: [
    {
      files: ['src/styles/tokens.css'],
      rules: { 'color-no-hex': null },
    },
  ],
};
