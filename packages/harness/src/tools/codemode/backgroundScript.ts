/**
 * A `script` call sent to the background: the call returns at once with the
 * id of a child run that makes the same call, `{ kind: 'script', title }`.
 * That run is the parent's agent with the parent's tools, model and working
 * directory, opened on the call (`AgentConfig.script`); its result reaches
 * the parent as one follow-up (`createScriptRunStrategy`), and a resume
 * replays it from its own rows.
 */
import { Effect, SynchronizedRef } from 'effect';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { offeredBy } from '@agent/runtime/loop/step';
import { createScriptRunStrategy } from '@agent/runtime/scriptRun';
import { type RunToolCall } from '@agent/runtime/RunCall';
import { withLogChannel } from '@logger/effectLog';
import { USER_FOLLOW_UP_SUPPORT, type RunId } from '@shared/schemas';
import { executed } from '@tools/core/result';
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
  input: { readonly code: string; readonly timeoutMs?: number },
  title: string,
) {
  const { run } = call;
  const { session, runId: parentRunId } = run;
  const earlier = yield* earlierChild(call);
  if (earlier !== null) return receipt(title, earlier, true);
  const bound = yield* SynchronizedRef.get(run.model);
  const runId = agentChildRunId(call);
  const workingDirectory =
    call.env.workingDirectory ?? run.config.workingDirectory;
  const parentOffered = yield* offeredBy(run);
  // The parent's agent, model and tools, opened on the call rather than on
  // a prompt: it reads no input files and renders no instruction.
  const definition = yield* prepareAgentDefinition({
    config: AgentConfigSchema.parse({
      ...run.config,
      model: bound.modelId,
      instruction: '',
      displayInstruction: null,
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      memories: [],
      outputSchema: null,
      cli: null,
      workingDirectory: workingDirectory ?? null,
      delegationAgentScope: run.delegationAgentScope ?? null,
      script: {
        code: input.code,
        title,
        // The tools its parent's step offered it, less the parent's own
        // terminal tool and the script tool its run adds itself.
        tools: parentOffered.flatMap(({ name, plugin }) =>
          plugin === 'run' || name === 'script' ? [] : [name],
        ),
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
        kind: 'background',
      },
    }),
    session,
    suppressErrorNotification: true,
  });
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
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
                // Registered with its opening, which its run commits.
                registration: {
                  identity: { kind: 'script', title },
                  userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
                  parentRunId,
                  parentCard: call.logId,
                  parentCallId: call.callId,
                  description: childRunDescription(title),
                },
                runId,
                parentRunId,
                session,
                startedAt: Date.now(),
                ...(workingDirectory != null && { workingDirectory }),
                parentOffered,
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
