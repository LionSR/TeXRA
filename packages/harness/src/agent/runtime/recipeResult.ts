/**
 * What a recipe run reports, through the block its script names
 * (`script.block`, read with that block's `AgentBlock.result`): the
 * delivery body its launching model reads and the files it wrote, both
 * read from the run's latest row of the block's fact kind. A run that is no
 * recipe has none.
 */
import { factName } from '@shared/schemas';
import { Effect, Result, Schema, SchemaIssue } from 'effect';

import type { AgentConfig } from '@shared/schemas/agentConfig';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunId } from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import type { DatabaseReadFailed } from '@shared/session/database';
import { escapeAttr } from '@shared/utils/xmlEscape';
import { ToolRegistry, type RecipeChange } from '@tools/toolTable';

/** A recipe run's value as its block reads it. */
export interface RecipeResult {
  /** The block's key (`kind` on the delivery). */
  readonly key: string;
  /** The delivery body; empty when no listed plugin reads the block. */
  readonly delivery: readonly string[];
  readonly changes: readonly RecipeChange[];
}

/**
 * The result of the completed run `runId`, launched with `config`, or
 * undefined for a run that is no recipe (or has no recorded config). A
 * block no listed plugin reads, a run with no row of the block's fact kind,
 * or a row its schema refuses, is logged and read as no files; the refusal
 * is also the delivery, so the launching model sees it.
 */
export const readRecipeResult = Effect.fn('readRecipeResult')(function* (
  config: Pick<AgentConfig, 'script'> | null,
  runId: RunId,
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Effect.fn.Return<
  RecipeResult | undefined,
  DatabaseReadFailed,
  ToolRegistry | SessionLog
> {
  const script = config?.script;
  if (script?.kind !== 'recipe') return undefined;
  const key = script.block;
  const result = (yield* ToolRegistry).blocks.get(key)?.result;
  if (result === undefined) {
    yield* Effect.logWarning(
      `No listed plugin reads the '${key}' block: recipe run ${runId} delivers its reply alone.`,
    ).pipe(withLogChannel('RecipeResult'));
    return { key, delivery: [], changes: [] };
  }
  const { schema } = result.fact;
  const name = factName(result.fact);
  const row = (yield* (yield* SessionLog).facts(runId))?.facts[name];
  const refused = (reason: string) =>
    Effect.logWarning(
      `Recipe run ${runId} reports nothing its '${key}' block reads: ${reason}`,
    ).pipe(
      withLogChannel('RecipeResult'),
      Effect.as({
        key,
        delivery: [`<invalid-result reason="${escapeAttr(reason)}" />`],
        changes: [],
      }),
    );
  if (row === undefined)
    return yield* refused(`the run recorded no '${name}' row`);
  const parsed = Schema.decodeUnknownResult(schema)(row.value, {
    errors: 'all',
  });
  if (Result.isFailure(parsed)) {
    return yield* refused(
      SchemaIssue.makeFormatterStandardSchemaV1()(parsed.failure.issue)
        .issues.map(
          ({ path, message }) =>
            `${(path ?? []).map(String).join('.') || 'value'}: ${message}`,
        )
        .join('; '),
    );
  }
  return {
    key,
    delivery: result.delivery(parsed.success, runId),
    changes: result.changes(parsed.success, roots),
  };
});
