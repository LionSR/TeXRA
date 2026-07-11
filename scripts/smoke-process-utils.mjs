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

export function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

export function delay(ms) {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, ms);
    timeout.unref();
  });
}

async function waitForExitOrTimeout(exitPromise, timeoutMs) {
  return Promise.race([
    exitPromise.then((exit) => ({ exit })),
    delay(timeoutMs).then(() => ({ timeout: true })),
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
