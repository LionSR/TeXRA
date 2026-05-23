/**
 * No-op TexraTrace used as the default for RunContexts created without an
 * explicit trace. Mirrors `@agent/trace/noopTrace` but covers the TeXRA
 * extension methods so callers that type `ctx.trace: TexraTrace` don't
 * pay an undefined-method cost.
 */
import { randomUUID } from 'node:crypto';

import { noopTrace } from '@agent/trace';

import type { TexraTrace, ToolStartRef } from './TexraTrace';

const NOOP: () => void = () => undefined;
const NOOP_TOOL_REF = (): ToolStartRef => ({
  logId: randomUUID(),
  groupId: undefined,
});

export const noopTexraTrace: TexraTrace = {
  ...noopTrace,

  logError: NOOP,
  logProgress: NOOP,
  logErrorData: NOOP,
  logInternal: NOOP,
  debugInternal: NOOP,
  logScratchpad: NOOP,
  logContextManagement: NOOP,
  logContextState: NOOP,
  missingOutputs: NOOP,
  latexDiff: NOOP,
  userMessage: NOOP,

  filesLoaded: NOOP,
  logFileCategory: NOOP,

  emitToolUse: NOOP_TOOL_REF,
  logToolUseStart: NOOP_TOOL_REF,
  updateToolUse: NOOP,
  logWebSearch: NOOP,
  logWebFetch: NOOP,

  startGroup: (_name, id) => id ?? randomUUID(),
  endGroup: NOOP,
};
