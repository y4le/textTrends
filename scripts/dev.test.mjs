import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { developmentCommands, runDevelopment } from './dev.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'texttrends-dev-'));
  const log = join(directory, 'events.jsonl');
  const signals = new EventEmitter();
  const events = () => {
    try { return readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  };
  const command = (name, body = 'setInterval(() => {}, 1000);') => [
    process.execPath, '-e', `
      const { appendFileSync } = require('node:fs');
      const record = (event) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
      process.on('SIGTERM', () => { record('${name}:stopped'); process.exit(0); });
      record('${name}:started');
      ${body}
    `,
  ];
  const waitFor = async (event) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (events().includes(event)) return;
      await delay(10);
    }
    assert.fail(`Timed out waiting for ${event}: ${events()}`);
  };
  let running;
  t.after(async () => {
    signals.emit('SIGTERM');
    await running;
    rmSync(directory, { recursive: true, force: true });
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  });
  return {
    events, command, signals, waitFor,
    run(overrides = {}) {
      running = runDevelopment({
        cwd: directory,
        signals,
        stdio: 'ignore',
        graceMs: 100,
        commands: {
          build: command('build', "record('build:done'); process.exit(0);"),
          watch: command('watch'),
          server: command('server'),
          ...overrides,
        },
      });
      return running;
    },
  };
}

test('development commands share one referenced-package watcher and forward server arguments', () => {
  const local = developmentCommands(['--host', '127.0.0.1', '--port', '5234']);
  const tailnet = developmentCommands(['--tailnet', '--open']);
  assert.deepEqual(local.build, ['pnpm', 'build:packages']);
  assert.deepEqual(local.watch, ['pnpm', '--filter', '@texttrends/standard-ebooks', 'exec',
    'tsc', '-b', 'tsconfig.build.json', '--watch', '--preserveWatchOutput']);
  assert.deepEqual(tailnet.watch, local.watch);
  assert.deepEqual(local.server, ['pnpm', '--filter', '@texttrends/web', 'dev',
    '--host', '127.0.0.1', '--port', '5234']);
  assert.deepEqual(tailnet.server, ['bash', 'scripts/dev-tailnet.sh', '--open']);
});

test('initial build failure prevents the server and watcher from starting', async (t) => {
  const f = fixture(t);
  assert.equal(await f.run({ build: f.command('build', 'process.exit(2);') }), 2);
  assert.deepEqual(f.events(), ['build:started']);
});

test('missing build command fails without starting long-running children', async (t) => {
  const f = fixture(t);
  assert.equal(await f.run({ build: ['/texttrends-no-such-command'] }), 1);
  assert.deepEqual(f.events(), []);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} stops both children after the initial build barrier`, async (t) => {
    const f = fixture(t);
    const running = f.run();
    await Promise.all([f.waitFor('watch:started'), f.waitFor('server:started')]);
    const events = f.events();
    assert.ok(events.indexOf('build:done') < events.indexOf('watch:started'));
    assert.ok(events.indexOf('build:done') < events.indexOf('server:started'));
    f.signals.emit(signal);
    assert.equal(await running, signal === 'SIGINT' ? 130 : 143);
    assert.ok(f.events().includes('watch:stopped'));
    assert.ok(f.events().includes('server:stopped'));
  });
}

test('interrupting the build does not start the watcher or server', async (t) => {
  const f = fixture(t);
  const running = f.run({ build: f.command('build') });
  await f.waitFor('build:started');
  f.signals.emit('SIGINT');
  assert.equal(await running, 130);
  assert.deepEqual(f.events(), ['build:started', 'build:stopped']);
});

for (const role of ['watch', 'server']) {
  test(`${role} exit stops its sibling and preserves failure status`, async (t) => {
    const f = fixture(t);
    const other = role === 'watch' ? 'server' : 'watch';
    const running = f.run({ [role]: f.command(role, `
      const timer = setInterval(() => {
        if (require('node:fs').readFileSync(${JSON.stringify('events.jsonl')}, 'utf8').includes('${other}:started')) {
          clearInterval(timer);
          process.exit(7);
        }
      }, 10);
    `) });
    assert.equal(await running, 7);
    assert.ok(f.events().includes(`${other}:stopped`));
  });
}

test('a watcher exiting successfully is still a development failure', async (t) => {
  const f = fixture(t);
  assert.equal(await f.run({ watch: f.command('watch', 'process.exit(0);') }), 1);
  assert.ok(f.events().includes('watch:started'));
});

test('shutdown kills an unresponsive child after the grace period', async (t) => {
  const f = fixture(t);
  const running = f.run({ watch: f.command('watch', `
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => record('watch:ignored'));
    setInterval(() => {}, 1000);
  `) });
  await Promise.all([f.waitFor('watch:started'), f.waitFor('server:started')]);
  f.signals.emit('SIGTERM');
  assert.equal(await running, 143);
  assert.ok(f.events().includes('watch:ignored'));
  assert.ok(f.events().includes('server:stopped'));
});

test('shutdown reaches descendants of a package-manager process', {
  skip: process.platform === 'win32',
}, async (t) => {
  const f = fixture(t);
  const grandchild = f.command('grandchild');
  const running = f.run({ watch: f.command('watch', `
    const child = require('node:child_process').spawn(
      ${JSON.stringify(grandchild[0])}, ${JSON.stringify(grandchild.slice(1))}, { stdio: 'ignore' });
    process.removeAllListeners('SIGTERM');
    process.on('SIGTERM', () => {});
    child.on('exit', () => { record('watch:reaped-grandchild'); process.exit(0); });
  `) });
  await Promise.all([f.waitFor('grandchild:started'), f.waitFor('server:started')]);
  f.signals.emit('SIGTERM');
  assert.equal(await running, 143);
  assert.ok(f.events().includes('grandchild:stopped'));
  assert.ok(f.events().includes('watch:reaped-grandchild'));
});
