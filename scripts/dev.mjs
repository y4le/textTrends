import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

export function developmentCommands(args = []) {
  const tailnet = args[0] === '--tailnet';
  const serverArgs = tailnet ? args.slice(1) : args;
  return {
    build: ['pnpm', 'build:packages'],
    // This project's references include EPUB, so one compiler owns both outputs.
    watch: ['pnpm', '--filter', '@texttrends/standard-ebooks', 'exec', 'tsc',
      '-b', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'],
    server: tailnet
      ? ['bash', 'scripts/dev-tailnet.sh', ...serverArgs]
      : ['pnpm', '--filter', '@texttrends/web', 'dev', ...serverArgs],
  };
}

/** Build once, then keep the package compiler and dev server alive together. */
export async function runDevelopment({
  commands = developmentCommands(),
  cwd = repoRoot,
  signals = process,
  stdio = 'inherit',
  graceMs = 3000,
} = {}) {
  const jobs = new Set();
  const processGroups = process.platform !== 'win32';
  let stopping;
  let exitCode;

  function signalJob(job, signal) {
    if (!job.child.pid) return;
    try {
      // pnpm and the Tailnet shell own descendants; stop their entire group.
      if (processGroups) process.kill(-job.child.pid, signal);
      else job.child.kill(signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  function stop(code) {
    if (stopping) return stopping;
    exitCode = code;
    stopping = (async () => {
      for (const job of jobs) signalJob(job, 'SIGTERM');
      let timeout;
      await Promise.race([
        Promise.all([...jobs].map((job) => job.done)),
        new Promise((done) => { timeout = setTimeout(done, graceMs); }),
      ]);
      clearTimeout(timeout);
      // Also collect descendants whose parent exited before they did.
      for (const job of jobs) signalJob(job, 'SIGKILL');
      await Promise.all([...jobs].map((job) => job.done));
    })();
    return stopping;
  }

  function start(command) {
    const [executable, ...args] = command;
    const child = spawn(executable, args, { cwd, stdio, detached: processGroups });
    const job = { child, done: null };
    job.done = new Promise((done) => {
      child.once('error', (error) => {
        console.error(`[dev] Could not start ${executable}: ${error.message}`);
        done(1);
      });
      child.once('exit', (code, signal) => {
        done(code ?? (128 + (constants.signals[signal] ?? 1)));
      });
    });
    jobs.add(job);
    return job;
  }

  const onInterrupt = () => { void stop(130); };
  const onTerminate = () => { void stop(143); };
  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerminate);

  try {
    const build = start(commands.build);
    const buildCode = await build.done;
    if (stopping) {
      await stopping;
      return exitCode;
    }
    if (buildCode !== 0) {
      await stop(buildCode);
      return exitCode;
    }
    jobs.delete(build);

    const watch = start(commands.watch);
    const server = start(commands.server);
    const code = await Promise.race([
      // A watch process finishing successfully is still an unexpected exit.
      watch.done.then((watchCode) => watchCode || 1),
      server.done,
    ]);
    await stop(code);
    return exitCode;
  } finally {
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDevelopment({ commands: developmentCommands(process.argv.slice(2)) });
}
