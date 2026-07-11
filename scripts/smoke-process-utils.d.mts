export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ExitObservable {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface ProcessErrorObservable {
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface StoppableChild extends ExitObservable {
  kill(signal: NodeJS.Signals): unknown;
}

export function appendBoundedLog(
  current: string,
  chunk: string | Uint8Array,
  maxLogChars: number,
): string;

export function formatExit(exit: ProcessExit): string;

export function hasExited(child: ExitObservable): boolean;

/** Wait for process exit, rejecting if the child reports a process error. */
export function waitForExit(
  child: ExitObservable & ProcessErrorObservable,
): Promise<ProcessExit>;

/** Wait for actual process exit without treating an error event as exit. */
export function waitForTermination(child: ExitObservable): Promise<ProcessExit>;

export function delay(ms: number): Promise<void>;

export function stopChild(
  child: StoppableChild,
  exitPromise: Promise<ProcessExit>,
  options: { graceMs: number; label?: string },
): Promise<ProcessExit>;
