/** Canonical CLI process exit codes. */
export const CliExitCode = {
  Success: 0,
  AgentError: 1,
  Usage: 2,
  ModelOrNetworkError: 3,
  Cancelled: 124,
  Interrupted: 130,
  Terminated: 143,
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];
