/**
 * What a recipe run's return value reads as, through the block its script
 * names (`script.block`, read with that block's `AgentBlock.result`): the
 * delivery body its launching model reads and the files it wrote. The one
 * reader of a recipe's `output.structured`; a run that is no recipe has
 * none.
 */
import { Effect, Result, Schema, SchemaIssue } from 'effect';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { withLogChannel } from '@logger/effectLog';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { RunEndOutput, RunId } from '@shared/schemas';
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
 * The result of a run launched with `config` that ended with `output`, or
 * undefined for a run that is no recipe (or has no recorded config). A block no listed plugin reads, or
 * a value its schema refuses, is logged and read as no files; the refusal is
 * also the delivery, so the launching model sees it.
 */
export const readRecipeResult = Effect.fn('readRecipeResult')(function* (
  config: Pick<AgentConfig, 'script'> | null,
  output: RunEndOutput,
  runId: RunId,
  roots: Pick<WorkspaceRoots, 'workspace' | 'storage'>,
): Effect.fn.Return<RecipeResult | undefined, never, ToolRegistry> {
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
  const parsed = Schema.decodeUnknownResult(result.schema)(output.structured, {
    errors: 'all',
  });
  if (Result.isFailure(parsed)) {
    const reason = SchemaIssue.makeFormatterStandardSchemaV1()(
      parsed.failure.issue,
    )
      .issues.map(
        ({ path, message }) =>
          `${(path ?? []).map(String).join('.') || 'value'}: ${message}`,
      )
      .join('; ');
    yield* Effect.logWarning(
      `Recipe run ${runId} returned a value its '${key}' block refuses: ${reason}`,
    ).pipe(withLogChannel('RecipeResult'));
    return {
      key,
      delivery: [`<invalid-result reason="${escapeAttr(reason)}" />`],
      changes: [],
    };
  }
  return {
    key,
    delivery: result.delivery(parsed.success, runId),
    changes: result.changes(parsed.success, roots),
  };
});
