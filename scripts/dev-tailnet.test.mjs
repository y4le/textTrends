import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const devTailnet = join(repoRoot, 'scripts/dev-tailnet.sh');

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate a test port'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(address.port);
      });
    });
  });
}

function portIsOpen(port) {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveOpen(open);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

let tempRoot;
let helperPath;
let vitePath;
let helperLog;
let viteLog;
let exposeMarker;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'texttrends-dev-tailnet-'));
  helperPath = join(tempRoot, 'tailnet-dev-host');
  vitePath = join(tempRoot, 'vite');
  helperLog = join(tempRoot, 'helper.jsonl');
  viteLog = join(tempRoot, 'vite.json');
  exposeMarker = join(tempRoot, 'exposed');

  executable(
    helperPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(2);
fs.appendFileSync(process.env.HELPER_LOG, JSON.stringify([command, ...args]) + '\\n');
if (command === 'status') process.stdout.write('{"routes":[]}');
else if (command === 'expose') {
  if (process.env.FAIL_EXPOSE === '1') process.exit(1);
  fs.writeFileSync(process.env.EXPOSE_MARKER, '');
  process.stdout.write('{"action":"expose","url":"https://spark.test.ts.net/textTrends/"}');
} else process.exit(2);
`,
  );

  executable(
    vitePath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(process.env.VITE_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  tailnetPath: process.env.TT_TAILNET_PATH,
}));
const server = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n'));
const closeServer = (status = 0) => server.close(() => process.exit(status));
server.listen(Number(valueAfter('--port')), valueAfter('--host'), () => {
  const markerPoll = setInterval(() => {
    if (fs.existsSync(process.env.EXPOSE_MARKER)) {
      clearInterval(markerPoll);
      closeServer();
    }
  }, 10);
});
process.on('SIGTERM', () => closeServer(143));
`,
  );
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test('dev:tailnet exposes only the textTrends path on loopback', async () => {
  const port = await freePort();
  const result = spawnSync('bash', [devTailnet, '--open'], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPOSE_MARKER: exposeMarker,
      HELPER_LOG: helperLog,
      PORT: String(port),
      TAILNET_DEV_HOST_BIN: helperPath,
      VITE_BIN: vitePath,
      VITE_LOG: viteLog,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tailnet URL: https:\/\/spark\.test\.ts\.net\/textTrends\//);

  const vite = JSON.parse(readFileSync(viteLog, 'utf8'));
  assert.deepEqual(vite, {
    args: [
      '--open',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
      '--clearScreen',
      'false',
    ],
    cwd: join(repoRoot, 'apps/web'),
    tailnetPath: '/textTrends',
  });

  const helperCalls = readFileSync(helperLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(helperCalls.map(([command]) => command), ['status', 'expose']);
  assert.deepEqual(helperCalls.at(-1), [
    'expose',
    '--name',
    'texttrends',
    '--repo',
    repoRoot,
    '--path',
    '/textTrends',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--json',
  ]);
});

test('dev:tailnet stops Vite when Tailnet exposure fails', async () => {
  const port = await freePort();
  const result = spawnSync('bash', [devTailnet], {
    cwd: tempRoot,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      EXPOSE_MARKER: exposeMarker,
      FAIL_EXPOSE: '1',
      HELPER_LOG: helperLog,
      PORT: String(port),
      TAILNET_DEV_HOST_BIN: helperPath,
      VITE_BIN: vitePath,
      VITE_LOG: viteLog,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tailnet exposure failed; Vite will stop/);
  assert.doesNotThrow(() => readFileSync(viteLog));
  assert.equal(await portIsOpen(port), false);
  const helperCalls = readFileSync(helperLog, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(helperCalls.map(([command]) => command), ['status', 'expose']);
});

test('dev:tailnet refuses an occupied port before starting Vite', async () => {
  const occupied = createServer();
  await new Promise((resolveListen, reject) => {
    occupied.once('error', reject);
    occupied.listen(0, '127.0.0.1', resolveListen);
  });
  const address = occupied.address();
  if (!address || typeof address === 'string') {
    occupied.close();
    throw new Error('Could not allocate an occupied test port');
  }

  try {
    const result = spawnSync('bash', [devTailnet], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        EXPOSE_MARKER: exposeMarker,
        HELPER_LOG: helperLog,
        PORT: String(address.port),
        TAILNET_DEV_HOST_BIN: helperPath,
        VITE_BIN: vitePath,
        VITE_LOG: viteLog,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /already in use; choose another PORT/);
    assert.doesNotThrow(() => readFileSync(helperLog));
    assert.throws(() => readFileSync(viteLog));
  } finally {
    await new Promise((resolveClose, reject) => {
      occupied.close((error) => error ? reject(error) : resolveClose());
    });
  }
});

test('dev:tailnet rejects routing flags before consulting the helper', async () => {
  const port = await freePort();
  const result = spawnSync('bash', [devTailnet, '--port', '9999'], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPOSE_MARKER: exposeMarker,
      HELPER_LOG: helperLog,
      PORT: String(port),
      TAILNET_DEV_HOST_BIN: helperPath,
      VITE_BIN: vitePath,
      VITE_LOG: viteLog,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /use HOST or PORT/);
  assert.throws(() => readFileSync(helperLog));
  assert.throws(() => readFileSync(viteLog));
});

test('dev:tailnet refuses a non-loopback host before consulting the helper', async () => {
  const port = await freePort();
  const result = spawnSync('bash', [devTailnet], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPOSE_MARKER: exposeMarker,
      HELPER_LOG: helperLog,
      HOST: '0.0.0.0',
      PORT: String(port),
      TAILNET_DEV_HOST_BIN: helperPath,
      VITE_BIN: vitePath,
      VITE_LOG: viteLog,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /HOST must be 127\.0\.0\.1 or localhost/);
  assert.throws(() => readFileSync(helperLog));
  assert.throws(() => readFileSync(viteLog));
});

test('dev:tailnet refuses a mount that disagrees with the fixed app base', async () => {
  const port = await freePort();
  const result = spawnSync('bash', [devTailnet], {
    cwd: tempRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      EXPOSE_MARKER: exposeMarker,
      HELPER_LOG: helperLog,
      PORT: String(port),
      TAILNET_DEV_HOST_BIN: helperPath,
      TAILNET_PATH: '/tt',
      VITE_BIN: vitePath,
      VITE_LOG: viteLog,
    },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must remain \/textTrends to match the app's fixed Vite base/);
  assert.throws(() => readFileSync(helperLog));
  assert.throws(() => readFileSync(viteLog));
});
