/**
 * A `script` call sent to the background: the call returns at once with the
 * id of a child run that makes the same call, `{ kind: 'script', title }`.
 * That run is the parent's agent with the parent's tools, model and working
 * directory, opened on the call (`AgentConfig.backgroundScript`); its result reaches
 * the parent as one follow-up (`createScriptRunStrategy`), and a resume
 * replays it from its own rows.
 */
import { Effect, SynchronizedRef } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { offeredBy } from '@agent/runtime/loop/step';
import { createScriptRunStrategy } from '@agent/runtime/scriptRun';
import { registerRun } from '@agent/storage/runLifecycle';
import { withLogChannel } from '@logger/effectLog';
import {
  AgentCategory,
  ToolError,
  USER_FOLLOW_UP_SUPPORT,
  type JsonValue,
  type RunId,
} from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { executed } from '@tools/core/result';
import type { RunToolCall } from '@tools/core/toolRun';
import { agentChildRunId, earlierChild } from '@tools/delegation/agentChild';
import { childRunDescription } from '@tools/delegation/childRun';
import { startDetachedChildRunLoop } from '@tools/delegation/detachedChildRun';

/** What the model reads for a script sent to the background. */
const receipt = (title: string, runId: RunId, again: boolean) => ({
  ...executed(
    [
      again
        ? `The script '${title}' was sent to the background by an earlier attempt of this call; its result arrives as a follow-up.`
        : `The script '${title}' runs in the background; its result and summary arrive as one follow-up message when it ends. Continue other work meanwhile.`,
      `Run ID: ${runId}`,
      `To look at its calls without waiting: executions tool with path=/executions/${runId}.`,
    ].join('\n'),
    `Script '${title}' running in the background`,
  ),
  value: { runId },
});

/**
 * Launch the background run of a `script` call. The run is named by the
 * call and its attempt, so a resumed call finds the run an earlier attempt
 * launched instead of launching a second.
 */
export const launchBackgroundScript = Effect.fn('script.background')(function* (
  call: RunToolCall,
  tool: string,
  input: { readonly [field: string]: JsonValue },
  title: string,
) {
  const { run } = call;
  const { session, runId: parentRunId } = run;
  const earlier = yield* earlierChild(call);
  if (earlier !== null) return receipt(title, earlier, true);
  const bound = yield* SynchronizedRef.get(run.model);
  // An editor binding's turns carry no calls for the run to open on.
  if (bound.origin.protocol === 'vscode-lm')
    return yield* Effect.fail(
      new ToolError(
        'A script cannot run in the background on a VS Code language model. Run it in the foreground.',
      ),
    );
  const runId = agentChildRunId(call);
  const workingDirectory = call.workingDirectory ?? run.config.workingDirectory;
  // The parent's agent, model and tools, opened on the call rather than on
  // a prompt: it reads no input files and renders no instruction.
  const definition = yield* prepareAgentDefinition({
    config: AgentConfigSchema.parse({
      ...run.config,
      agentCategory: AgentCategory.ToolUse,
      model: bound.modelId,
      instruction: '',
      displayInstruction: null,
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      editedFiles: [],
      memories: [],
      outputSchema: null,
      cli: null,
      workingDirectory: workingDirectory ?? null,
      delegationAgentScope: run.delegationAgentScope ?? null,
      backgroundScript: { tool, input, title },
    }),
    session,
    enforceCategory: true,
    suppressErrorNotification: true,
  });
  const parentOffered = yield* offeredBy(run);
  // Its calls' approvals follow the parent's live ones.
  const inherit = (childRunId: RunId): void =>
    configureDelegatedChildApprovals(
      childRunId,
      parentRunId,
      'inherit',
      session,
    );
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      yield* registerRun(session, runId, definition.config, {
        identity: { kind: 'script', title },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
        parentRunId,
        ...(call.logId !== undefined && { parentCard: call.logId }),
        ...(call.toolCallId !== undefined && {
          parentCallId: call.toolCallId,
        }),
        description: childRunDescription(title),
      });
      yield* startDetachedChildRunLoop({
        session,
        runId,
        parentRunId,
        agentName: title,
        budgeted: true,
        // It reports once, at its end: no progress follow-ups.
        notify: () => undefined,
        buildLaunch: () =>
          restore(Effect.void).pipe(
            Effect.as({
              strategy: createScriptRunStrategy({
                definition,
                runId,
                parentRunId,
                session,
                startedAt: Date.now(),
                ...(workingDirectory != null && { workingDirectory }),
                parentOffered,
                onRunResolved: inherit,
                title,
              }),
              onLoopFailed: (error: unknown) =>
                Effect.logError(
                  `Background script '${title}' run loop failed after launch`,
                ).pipe(
                  Effect.annotateLogs({ data: error }),
                  withLogChannel('childRunLoop'),
                ),
            }),
          ),
      });
    }),
  );
  return receipt(title, runId, false);
});
