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

function waitForExitEvent(child, rejectOnError) {
  if (hasExited(child)) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('exit', onExit);
      if (onError) child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = rejectOnError
      ? (error) => {
          cleanup();
          reject(error);
        }
      : undefined;

    child.once('exit', onExit);
    if (onError) child.once('error', onError);
    // Close the check/listener TOCTOU interval: an exit that happened between
    // the first check and listener registration has updated these fields even
    // if its event was missed.
    if (hasExited(child)) {
      cleanup();
      resolve({ code: child.exitCode, signal: child.signalCode });
    }
  });
}

/** Wait for process exit, rejecting if the child reports a process error. */
export function waitForExit(child) {
  return waitForExitEvent(child, true);
}

/** Wait for actual process exit without treating an error event as exit. */
export function waitForTermination(child) {
  return waitForExitEvent(child, false);
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
