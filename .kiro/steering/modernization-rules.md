---
inclusion: always
---

# Modernization Rules

> Always-on migration knowledge. Every diagnosis, Grimoire edit and Skeleton task cites a rule ID from this file. The exact matching and editing rules are in design sections R3-7 and R3-8.

| ID | Rule | Detection | Target |
|---|---|---|---|
| M1 | Python 2 to 3 | `print x`, `print >>f, x`, `except E, e`, `unicode(`, `.iteritems()`, `.iterkeys()`, `.itervalues()` | `print(...)`, `except E as e`, `str(...)`, `.items()`, `.keys()`, `.values()`; other Python 2 residue is recorded as `unknown` |
| M2 | Callback `request` package | `require('request')`, `require("request")`, `import request from 'request'`; `request-promise`, `request-promise-native` and `request-promise-any` are reported without an edit | Native `fetch` through the `request-compat.cjs` adapter, for eligible call sites only; `engines.node` set to `>=22` |
| M3 | CommonJS to ESM | `require(`, `module.exports` | `import` and `export`, for applications only; libraries and monorepos stay CommonJS |
| M4 | Webpack 2 to Vite | `webpack@2`, `CommonsChunkPlugin` | The current stable Vite, looked up at run time; the `CommonsChunkPlugin` mapping is `unknown` |
| M5 | Dependency drift | A `package.json` dependency 2 or more majors behind | Report only: listed in `design.md` with one manual task per manifest directory; Python M5 is `unknown` in v1 |
| M6 | Missing lock file | No lock file from any package manager in the manifest directory | A task: `npm install --package-lock-only --ignore-scripts`, or `poetry lock` when `pyproject.toml` has a `tool.poetry` table; in a live run the Bonesetter generates the lock file inside the runbox |

## Hard constraints

1. **Keep behavior.** Change syntax and dependencies only, not business logic. Write every behavior change into `design.md`.
2. **Traceable.** Every change maps to one rule ID.
3. **No invention.** Without evidence, record `unknown`; never make up a cause of death.
4. **Minimal diff.** Change one line rather than ten.
