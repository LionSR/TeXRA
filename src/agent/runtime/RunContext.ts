// Local imports - runtime
import type { AgentRuntimeHost } from './AgentRuntimeHost';

export type RunLogData = Record<string, unknown>;

export interface RunLogger {
  debug(message: string, data?: RunLogData): void;
  info(message: string, data?: RunLogData): void;
  warn(message: string, data?: RunLogData): void;
  error(message: string, data?: RunLogData): void;
}

export type ApprovalHandler<TRequest = unknown, TResult = unknown> = (
  request: TRequest,
) => Promise<TResult> | TResult;

export interface ApprovalHandlers {
  agentProposal?: ApprovalHandler;
  bash?: ApprovalHandler;
  plan?: ApprovalHandler;
  toolEdit?: ApprovalHandler;
}

export interface RunContext {
  readonly runtimeHost: AgentRuntimeHost;
  readonly logger: RunLogger;
  readonly approvals: ApprovalHandlers;
}

export interface CreateRunContextOptions {
  runtimeHost: AgentRuntimeHost;
  logger?: Partial<RunLogger>;
  approvals?: ApprovalHandlers;
}

const noopLog = (): void => undefined;

export function createRunContext(options: CreateRunContextOptions): RunContext {
  if (options.runtimeHost == null) {
    throw new Error('createRunContext requires an explicit runtimeHost');
  }

  const { logger, approvals } = options;

  return Object.freeze({
    runtimeHost: options.runtimeHost,
    logger: Object.freeze({
      debug: logger?.debug ?? noopLog,
      info: logger?.info ?? noopLog,
      warn: logger?.warn ?? noopLog,
      error: logger?.error ?? noopLog,
    }),
    approvals: Object.freeze({ ...approvals }),
  });
}
