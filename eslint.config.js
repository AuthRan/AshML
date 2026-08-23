/**
 * Lint rules chosen to catch defects, not to have opinions about formatting.
 *
 * Phase 0 listed a lint config as delivered and there was not one. Adding the usual
 * opinionated preset now would produce a thousand-line diff of quotes and commas across
 * code that is already consistent, which buys nothing and buries the next real change in
 * it. So the rule set is deliberately small: every rule here can fail on code that looks
 * fine and is wrong, and no rule here can fail on code that is right.
 *
 * The two that matter most are the ones that would have caught real defects in this
 * repo's history. `no-unused-vars` catches a binding computed and then not used — which
 * is what a half-finished refactor looks like from the outside. `require-atomic-updates`
 * catches a read-modify-write across an `await`, which is precisely the shape of every
 * bug the executor and the deployment sync loop are written to avoid.
 *
 * Style stays with the reviewer. This file exists so that `npm run lint` means something
 * a machine can check, and CI runs it.
 */

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    ignores: ['node_modules/**', 'data/**'],

    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        // Node 22. Listed rather than pulled from a `globals` package, because the list
        // is short and a dependency that exists to hold twelve strings is a dependency.
        process: 'readonly',
        crypto: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        queueMicrotask: 'readonly',
        structuredClone: 'readonly',
        globalThis: 'readonly',
        __dirname: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },

    rules: {
      // --- things that are simply wrong -------------------------------------------
      'no-undef': 'error',
      'no-unused-vars': ['error', {
        // An unused function argument is often a signature being honoured, so only
        // arguments *after* the last used one are flagged. An unused catch binding is
        // idiomatic here (`catch { }`) and is not a defect.
        args: 'after-used',
        caughtErrors: 'none',
        ignoreRestSiblings: true,
      }],
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-duplicate-case': 'error',
      'no-unreachable': 'error',
      'no-fallthrough': 'error',
      'no-self-assign': 'error',
      'no-self-compare': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-cond-assign': ['error', 'always'],
      'no-sparse-arrays': 'error',
      'valid-typeof': 'error',
      'use-isnan': 'error',

      // --- concurrency, which is where this codebase actually lives ----------------
      // A read-modify-write straddling an await. The executor, the scheduler and the
      // deployment sync loop are all written so that passes cannot overlap; this is the
      // rule that notices when one stops being.
      'require-atomic-updates': 'error',
      'no-async-promise-executor': 'error',
      'no-await-in-loop': 'off', // Deliberate throughout: these loops are sequential on purpose.
      'no-promise-executor-return': 'error',

      // --- things that are legal and never meant -----------------------------------
      'no-implicit-coercion': ['error', { boolean: false, allow: ['!!'] }],
      'no-return-assign': ['error', 'except-parens'],
      'no-throw-literal': 'error',
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', {
        // `== null` catches null and undefined together, which is used deliberately and
        // reads better than the alternative.
        null: 'ignore',
      }],
    },
  },

  {
    // The e2e, chaos and journey scripts are strictly sequential drivers: one check at a
    // time, each awaited before the next begins, carrying state between steps. There is
    // no concurrency for `require-atomic-updates` to find, so every report it makes here
    // is a false one — and seventeen false reports is how a rule stops being read.
    //
    // It stays on for `packages/**`, which is where the concurrency actually is: the
    // executor, the scheduler and the deployment sync loop are all written so that passes
    // cannot overlap, and this rule is what notices when one stops being.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    rules: {
      'require-atomic-updates': 'off',
    },
  },
];
