# test/fixtures/pinned/

Offline test fixtures for the Grimoire resurrection engine.

## Overview

This directory stores committed minimal snapshots of unmaintained repositories used for offline testing:
- Files read by the Grimoire detector (`package.json`, `*.js`, `*.cjs`, `*.mjs`, `*.ts`, `*.tsx`, `webpack.config.*`, and the six lock files for existence only)
- The project's `LICENSE` file
- `meta.json`: Frozen repository metadata (`owner`, `repo`, `sha`, `asOf`, `stars`, `lastWords`)
- `registry.json`: Frozen npm registry answers for M5 version drift analysis

The directory index is maintained in `repos.json`.

## Directory Layout

```
test/fixtures/pinned/
  README.md
  repos.json
  <owner>-<repo>@<sha>/
    meta.json
    registry.json
    LICENSE
    package.json
    ... (other detector-read source files at original paths)
```

## Pinning Fixtures

Fixtures are pinned using `scripts/fixtures/pin.ts`:

```bash
npx tsx scripts/fixtures/pin.ts --local <sourceDir> --owner <owner> --repo <repo> --asof <ISO time> --license <SPDX id> --registry <json file>
```

Or through the npm script:

```bash
npm run pin:fixtures -- --local <sourceDir> --owner <owner> --repo <repo> --asof <ISO time> --license <SPDX id> --registry <json file>
```

To run the self-test verification without writing to `01_evidence`:

```bash
npx tsx scripts/fixtures/pin.ts --selftest
```

## Permitted Redistribution Licenses

In accordance with redistribution rights (unknown U15), a fixture is refused unless `--license` is one of:
- `MIT`
- `Apache-2.0`
- `BSD-2-Clause`
- `BSD-3-Clause`
