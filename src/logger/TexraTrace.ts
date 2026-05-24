/**
 * `TexraTrace` is a deprecated alias for {@link AgentTrace}.
 *
 * Historical context: TeXRA's runtime trace once exposed ~20 sugar methods
 * (logError/logProgress/logContextManagement/...). All of those collapsed
 * into helper functions on `@agent/trace` (see `helpers.ts` and
 * `toolUseHelpers.ts`), so the host extension is now an empty subtype.
 * New code should import `AgentTrace` (and the helpers) directly from
 * `@agent/trace`.
 */
import type { AgentTrace } from '@agent/trace';
import type { FileListEntry } from '@shared/schemas';

export type TexraTrace = AgentTrace;

export interface FilesLoadedInput {
  readonly category: string;
  readonly entries: readonly FileListEntry[];
}

export type { ToolUseCardRef as ToolStartRef } from '@agent/trace';
