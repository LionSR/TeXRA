// The TeXRA background services a test home started, for the scripts and
// e2e fixtures that must stop them: a service is detached, so it outlives
// the client that started it and holds its home's stores until it stops.
// What a service writes is decided in `packages/texra/src/controllers/server/`
// (`discovery.ts` names the log, `serve.ts` writes the line read here).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The log the detached services of a data root (`<home>/.texra`) write. */
export function serviceLogPath(dataRoot) {
  return path.join(dataRoot, 'run', 'serve.log');
}

/**
 * The line each service writes once it holds the record, oldest first: its
 * build version, the socket it listens on, and its process id (which the
 * socket names). A missing log is a home that started no service.
 */
export function serviceAnnouncements(log) {
  let text;
  try {
    text = readFileSync(log, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return [
    ...text.matchAll(
      /TeXRA service (\S+) listening on (\S*serve-(\d+)\.sock)/g,
    ),
  ].map(([, version, socket, pid]) => ({
    version,
    socket,
    pid: Number(pid),
  }));
}

/**
 * Whether `pid` is still a running `texra … serve`. A pid a service logged
 * long ago may have been reused, and a zombie (a service the caller spawned
 * and has not reaped) has exited. Windows has no `ps`: there only whether
 * the process exists.
 */
export function serviceRunning(pid) {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const [stat = '', ...command] = spawnSync(
    'ps',
    ['-o', 'stat=', '-o', 'command=', '-p', String(pid)],
    { encoding: 'utf8' },
  )
    .stdout.trim()
    .split(/\s+/);
  return stat !== '' && !stat.startsWith('Z') && command.includes('serve');
}

/** The services of `dataRoot` that still run. */
export function servicePids(dataRoot) {
  return [
    ...new Set(
      serviceAnnouncements(serviceLogPath(dataRoot)).map(({ pid }) => pid),
    ),
  ].filter(serviceRunning);
}

/**
 * Stop the services of `dataRoot` and wait until they have exited; one still
 * running after `timeoutMs` is killed. Synchronous, so a process `exit`
 * handler can call it.
 */
export function stopServices(dataRoot, { timeoutMs = 10_000 } = {}) {
  const signal = (pid, name) => {
    try {
      process.kill(pid, name);
      return true;
    } catch {
      // Gone already: nothing left to stop.
      return false;
    }
  };
  const stopping = servicePids(dataRoot).filter((pid) =>
    signal(pid, 'SIGTERM'),
  );
  const pause = () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  for (
    let waited = 0;
    stopping.some(serviceRunning) && waited < timeoutMs;
    waited += 100
  )
    pause();
  for (const pid of stopping.filter(serviceRunning)) signal(pid, 'SIGKILL');
}
