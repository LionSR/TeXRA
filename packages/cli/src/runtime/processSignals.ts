/**
 * The process's signal listeners, held as policies: a holder names the
 * signals it answers, and a signal reaches the newest holder naming it. The
 * `process.on('SIG…')` of the CLI happens here and nowhere else, for a signal
 * exactly while some holder names it, so an unnamed signal keeps Node's
 * default.
 */
type CliSignal = 'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGTSTP' | 'SIGCONT';

/** What a holder does on each signal it names. */
export type SignalPolicy = Partial<Record<CliSignal, () => void>>;

const CLI_SIGNALS: readonly CliSignal[] = [
  'SIGINT',
  'SIGTERM',
  'SIGHUP',
  'SIGTSTP',
  'SIGCONT',
];
// Holders in the order they were taken; the newest naming a signal answers it.
const holders: SignalPolicy[] = [];
const listeners = new Map<CliSignal, () => void>();

function syncListeners(): void {
  for (const signal of CLI_SIGNALS) {
    const named = holders.some((policy) => policy[signal] !== undefined);
    const listener = listeners.get(signal);
    if (named && listener === undefined) {
      const answer = (): void =>
        holders
          .findLast((policy) => policy[signal] !== undefined)
          ?.[signal]?.();
      listeners.set(signal, answer);
      process.on(signal, answer);
    } else if (!named && listener !== undefined) {
      process.off(signal, listener);
      listeners.delete(signal);
    }
  }
}

/** Hold the signals `policy` names until the returned release runs. */
export function holdSignals(policy: SignalPolicy): () => void {
  holders.push(policy);
  syncListeners();
  return () => {
    const index = holders.lastIndexOf(policy);
    if (index >= 0) holders.splice(index, 1);
    syncListeners();
  };
}
