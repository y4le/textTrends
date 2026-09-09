import { execFileSync, fork, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, loadavg, totalmem } from 'node:os';

const requested = process.argv[2] ?? '1000000,10000000,50000000';
const tiers = requested.split(',').map(Number);
if (tiers.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 50_000_000)) throw new Error('tiers must be comma-separated integers from 1 through 50000000');
const output = process.argv[3];
if (!output) throw new Error('usage: node apps/web/bench/scale.mjs [tiers] output.json');
function rss(pid) {
  if (process.platform !== 'linux') return null;
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
  return match ? Number(match[1]) * 1024 : null;
}
async function measure(tokens, mode) {
  const loadAverage = loadavg();
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./scale-worker.ts', import.meta.url)), [String(tokens), mode], {
      execArgv: ['--experimental-transform-types', '--expose-gc', '--max-old-space-size=8192'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let timer = null, peak = null, samples = 0, completion = null;
    const phases = [];
    const sample = () => {
      try { const value = rss(child.pid); if (value !== null) { peak = Math.max(peak ?? value, value); samples++; } }
      catch { /* An exiting child cannot supply another sample. */ }
    };
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`tier ${tokens}/${mode} exceeded 15 minutes`)); }, 15 * 60_000);
    child.on('message', (message) => {
      if (message.kind === 'ready') {
        peak = null; samples = 0; sample(); timer = setInterval(sample, 1); child.send({ kind: 'go' });
      } else if (message.kind === 'phase') {
        sample(); clearInterval(timer); timer = null;
        const { kind, ...phase } = message;
        phases.push({ ...phase, sampledPeakRss: peak, samples, peakRssDelta: peak === null ? null : peak - phase.baseline.rss });
        console.error(`${tokens}/${mode} ${phase.name}: ${Math.round(phase.elapsedMs)}ms, peak ${peak === null ? 'unmeasured' : Math.round(peak / 1048576) + 'MiB'}`);
      } else if (message.kind === 'complete') completion = message;
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(timeout); clearInterval(timer);
      if (code !== 0 || !completion) reject(new Error(`tier ${tokens}/${mode} exited ${code ?? signal}`));
      else resolve({ ...completion, loadAverage, phases });
    });
  });
}
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const harnessHashes = Object.fromEntries(['scale.mjs', 'scale-worker.ts', 'scale-fixture.ts'].map((file) => [file, createHash('sha256').update(readFileSync(new URL(file, import.meta.url))).digest('hex')]));
const report = { sourceRevision, dirtyTrackedTree: spawnSync('git', ['diff', 'HEAD', '--quiet']).status !== 0, harnessHashes, schema: 'texttrends/engine-scale/1', capturedAt: new Date().toISOString(), host: { cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem() }, methodology: 'Fresh process per tier/mode; real WorkerEngineV4 with task-queue yields and production segmentation. Cache writes structured-clone then discard. Result buffers clone/transfer; no browser, IndexedDB I/O, message transport, or UI. Phase-local 1ms Linux RSS sampling; two query warmups then five samples. Ingest is one cold run per tier. Engine override changes only aggregate byte/text caps.', runs: [] };
for (const tokens of tiers) {
  const product = await measure(tokens, 'product'); report.runs.push(product);
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (product.errors.some((e) => e.code !== 'CAP_EXCEEDED')) throw new Error(`unexpected product failure: ${JSON.stringify(product.errors)}`);
  if (product.errors.length > 0) {
    const engine = await measure(tokens, 'engine');
    report.runs.push(engine);
    if (engine.errors.length > 0) throw new Error(`engine override failed: ${JSON.stringify(engine.errors)}`);
    writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
}
