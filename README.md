# qiankun ESM import-map race reproduction

This reproduction exercises the real `EsmSandboxEngine` with native browser Blob URLs, `import()` and import maps. It contains no application code, account data, or external API requests.

## Run

Use Node.js 22+ and a browser supporting dynamically injected multiple import maps.

```sh
npm install
npx playwright install chromium
npm run repro
```

To use an existing Chrome installation, set the `CHROME_PATH` environment variable to its executable path. To exercise a qiankun source checkout instead of the published shared package:

```sh
npm run repro -- --engine /path/to/qiankun/packages/shared/src/esm-sandbox/engine.ts
```

The source checkout must have its own dependencies installed. No qiankun file is modified. The script bundles the selected entry into a temporary directory, starts a loopback-only HTTP server, and cleans both up on completion.

## What the script does

The fixtures are three small modules:

```js
// a.js
import { v } from './shared.js';
export const value = v;

// b.js (the unrelated-graph case)
export const value = 7;

// shared.js
const history = {};
window.auditHistory = history;
export const v = 42;
```

The sandbox global set includes `window` and `history`. Its `moduleImporter` hook pauses the `shared.js` redeclaration probe with a Promise gate. Native `import()` still performs all parsing, resolution and evaluation; errors are not mocked.

While graph A is paused, graph B prepares and flushes its import map. This also publishes A's provisional shared-module URL. The script then releases A, whose collision probe rebuilds the module and revokes that old URL. Import-map registration reports a conflict, and native loading fails.

For the shared-dependency case, B's evaluation is also gated so it does not consume the provisional blob before it is revoked. The document-overlap case starts A through `registerDocumentModule()` / `importDocumentModules()` and B through `import()`.

## Expected observations on the affected engine

| Case | Observation |
| --- | --- |
| parallel-unrelated | A rejects with TypeError; conflicting map entry; published revoked URL |
| parallel-shared | A and B reject; conflicting map entry; published revoked URL |
| document-overlap | A rejects with TypeError; conflicting map entry; published revoked URL |
| serial | Both imports succeed; no conflict or revoked mapping |
| renamed | Same controlled overlap with local `history` renamed; both imports succeed |

Each case uses a fresh browser document. `stale` is captured before engine disposal, so it records probe rebuilding rather than normal disposal cleanup.

This is a bug-reproduction assertion harness: exit code 0 means the three failing cases and two passing controls were observed as documented. It is not a test suite asserting that the engine behaves correctly; after a concurrency fix, the gates/assertions may need adapting.

Tested against `@qiankunjs/shared@0.1.0-rc.14` as used by `qiankun@3.0.0-rc.22`, and the source engine at commit `6201077dfdfd35c9d2376b7393a2c522f9c28a9c`, with Chrome 150.0.7871.114 on Linux.

Vue, a router, authentication, and multiple sandbox instances are not required to reproduce the mechanism. The production symptom that led to this investigation was an intermittent lazy-route load failure, but this isolated reproduction does not claim to trace every production navigation event.
