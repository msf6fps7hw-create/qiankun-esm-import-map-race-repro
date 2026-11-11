// Native-browser reproduction; writes only to an isolated temporary directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { build } = require('esbuild');
const { chromium } = require('@playwright/test');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qiankun-race-audit-'));
const engineArg = process.argv.indexOf('--engine');
const sourceEntry = engineArg >= 0 ? path.resolve(process.argv[engineArg + 1])
  : require.resolve('@qiankunjs/shared/dist/esm/esm-sandbox/engine.js');
async function main() {
  for (const variant of ['engine']) {
    await build({
      entryPoints: [sourceEntry],
      outfile: path.join(tmp, `${variant}.js`), bundle: true, format: 'esm', platform: 'browser',
      define: { __QIANKUN_VERSION__: JSON.stringify('audit') },
    });
  }
  const server = http.createServer((req, res) => {
    const filename = path.join(tmp, path.basename(req.url));
    if (fs.existsSync(filename) && fs.statSync(filename).isFile()) {
      res.setHeader('Content-Type', 'text/javascript'); res.end(fs.readFileSync(filename));
    } else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>qiankun isolated race audit</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    headless: true,
  });
  try {
    console.log(JSON.stringify({browser: browser.version(), sourceFile: path.basename(sourceEntry), sourceSha256: createHash('sha256').update(fs.readFileSync(sourceEntry)).digest('hex')}));
    for (const variant of ['engine']) {
      for (const mode of ['parallel-unrelated', 'parallel-shared', 'document-overlap', 'serial', 'renamed']) {
        const page = await browser.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/`);
        const result = await page.evaluate(async ({variant, mode}) => {
          const { EsmSandboxEngine } = await import(`/${variant}.js`);
          const events = [], codes = new Map(), revoked = new Set(), conflicts = [];
          const originalError = console.error;
          console.error = (...args) => { conflicts.push(args.map(String).join(' ')); originalError(...args); };
          let signalPaused, releaseProbe, signalB, releaseB;
          const paused = new Promise(r => signalPaused = r);
          const probeGate = new Promise(r => releaseProbe = r);
          const bStarted = new Promise(r => signalB = r);
          const bGate = new Promise(r => releaseB = r);
          const base = `${location.origin}/fixtures/`;
          const shared = mode === 'renamed'
            ? 'const routerHistory = {}; window.auditHistory = routerHistory; export const v = 42;'
            : 'const history = {}; window.auditHistory = history; export const v = 42;';
          const engine = new EsmSandboxEngine({
            appName: 'audit', instanceId: 1, entryUrl: base,
            globalsBaseSet: ['window', 'history'], getGlobalsView: () => ({ window: {} }),
            fetch: async () => { throw new Error('Unexpected fixture fetch'); },
            modules: {
              [`${base}a.js`]: {source: 'import { v } from "./shared.js"; export const value = v;'},
              [`${base}b.js`]: {source: mode === 'parallel-shared' ? 'import { v } from "./shared.js"; export const value = v;' : 'export const value = 7;'},
              [`${base}shared.js`]: {source: shared},
            },
            createModuleUrl(code) { const url = URL.createObjectURL(new Blob([code], {type:'text/javascript'})); codes.set(url, code); return url; },
            revokeModuleUrl(url) { revoked.add(url); events.push({type:'revoke', url}); URL.revokeObjectURL(url); },
            async moduleImporter(url) {
              const code = codes.get(url) || '';
              if (mode !== 'serial' && code.includes('/__probe__') && code.includes(`${base}shared.js`)) {
                signalPaused(); await probeGate;
              }
              if (mode === 'parallel-shared' && code.includes(`${base}b.js`) && !code.includes('/__probe__')) {
                signalB(); await bGate;
              }
              return import(url);
            },
          });
          const observe = promise => promise.then(ns => ({ok:true, value:ns.value}), e => ({ok:false, name:e.name, message:e.message}));
          let a, b;
          if (mode === 'serial') {
            a = await observe(engine.import('./a.js'));
            b = await observe(engine.import('./b.js'));
          } else {
            let ap;
            if (mode === 'document-overlap') {
              engine.registerDocumentModule({ url: `${base}a.js`, baseUrl: base, isEntry: true });
              ap = observe(engine.importDocumentModules());
            } else { ap = observe(engine.import('./a.js')); }
            await paused;
            const bp = observe(engine.import('./b.js'));
            if (mode === 'parallel-shared') {
              await bStarted; releaseProbe(); a = await ap; releaseB(); b = await bp;
            } else {
              b = await bp; releaseProbe(); a = await ap;
            }
          }
          const imports = Object.assign({}, ...Array.from(document.querySelectorAll('script[type=importmap][data-qiankun=esm]'), s => JSON.parse(s.textContent).imports));
          const stale = Object.entries(imports).filter(([key, target]) => revoked.has(target)).map(([key,target]) => ({key,target}));
          engine.dispose(); console.error = originalError;
          return {variant, mode, a, b, conflicts, stale};
        }, {variant, mode});
        const shouldFail = mode === 'document-overlap' || mode.startsWith('parallel');
        assert.equal(result.a.ok, !shouldFail, `${variant}/${mode}: unexpected outcome`);
        assert.equal(result.conflicts.length > 0, shouldFail, `${variant}/${mode}: unexpected conflict count`);
        assert.equal(result.stale.length > 0, shouldFail, `${variant}/${mode}: unexpected revoked mapping`);
        if (shouldFail) assert.equal(result.a.name, 'TypeError');
        console.log(JSON.stringify(result));
        await page.close();
      }
    }
    console.log('Reproduction confirmed: 3 failing concurrent cases and 2 passing controls.');
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, {recursive:true, force:true}));
