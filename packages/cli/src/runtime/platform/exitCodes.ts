/** Canonical CLI process exit codes. */
export const CliExitCode = Object.freeze({
  Success: 0,
  AgentError: 1,
  Usage: 2,
  ModelOrNetworkError: 3,
  Cancelled: 124,
  Hangup: 129,
  Interrupted: 130,
  Terminated: 143,
} as const);

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

/** The code a process ends with when a signal ends it: 128 plus the
 *  signal's number, as a shell reports it. */
export const SIGNAL_EXIT_CODE = Object.freeze({
  SIGHUP: CliExitCode.Hangup,
  SIGINT: CliExitCode.Interrupted,
  SIGTERM: CliExitCode.Terminated,
});
