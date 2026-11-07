import { setTimeout as sleep } from 'node:timers/promises';

export function appendBoundedLog(current, chunk, maxLogChars) {
  const next = current + chunk.toString('utf8');
  return next.length > maxLogChars ? next.slice(-maxLogChars) : next;
}

export function formatExit(exit) {
  return exit.signal ?? `code ${exit.code}`;
}

export function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Wait for actual process exit without treating an error event as exit. */
export function waitForTermination(child) {
  if (hasExited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve) => {
    const onExit = (code, signal) => resolve({ code, signal });
    child.once('exit', onExit);
    // Close the check/listener TOCTOU interval: an exit that happened between
    // the first check and listener registration has updated these fields even
    // if its event was missed.
    if (hasExited(child)) {
      child.off('exit', onExit);
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

async function waitForExitOrTimeout(exitPromise, timeoutMs) {
  return Promise.race([
    exitPromise.then((exit) => ({ exit })),
    sleep(timeoutMs, { timeout: true }, { ref: false }),
  ]);
}

export async function stopChild(
  child,
  exitPromise,
  { graceMs, label = 'process' } = {},
) {
  if (!Number.isFinite(graceMs) || graceMs <= 0) {
    throw new Error('stopChild requires a positive graceMs value.');
  }

  if (hasExited(child)) return exitPromise;
  child.kill('SIGTERM');
  const gracefulExit = await waitForExitOrTimeout(exitPromise, graceMs);
  if (!gracefulExit.timeout) return gracefulExit.exit;

  child.kill('SIGKILL');
  const forcedExit = await waitForExitOrTimeout(exitPromise, graceMs);
  if (!forcedExit.timeout) return forcedExit.exit;

  throw new Error(`${label} did not exit within ${graceMs}ms after SIGKILL.`);
}
