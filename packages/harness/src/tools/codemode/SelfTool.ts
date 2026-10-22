/**
 * `self(prompt, opts)`: a script's function that runs this agent again, as
 * a child of the call. Forked (the default), the child continues the
 * conversation as it stood when the script started, with `prompt` added to
 * the message that started it (`forkChild`); fresh, it starts from `prompt` alone with the
 * conversation's files and memories. Either way it is the same agent with
 * the same tools, so nothing is proposed: the user approved the script.
 * The goal is this function in a loop (`goalScript`).
 */
import { Effect, Result, SynchronizedRef } from 'effect';
import { z } from 'zod';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { scriptChildBudget } from '@agent/runtime/childRunBudget';
import { forkChild } from '@agent/runtime/forkRun';
import { offeredBy } from '@agent/runtime/loop/step';
import {
  IssuingScript,
  requireToolRun,
  type RunToolCall,
} from '@agent/runtime/RunCall';
import { getRunRecords } from '@agent/storage/runRecords';
import { ToolError, type SubagentProgressUpdate } from '@shared/schemas';
import { defineTool } from '@tools/core/definition';
import { nullishWithDefault } from '@tools/core/inputSchema';
import { errorResult } from '@tools/core/result';
import { childResult, failedResult } from '@tools/delegation/AgentTool';
import {
  agentChildRunId,
  recoverAgentChild,
} from '@tools/delegation/agentChild';
import { childRunDescription } from '@tools/delegation/childRun';
import {
  executeSubagentInBand,
  resumeSubagentInBand,
} from '@tools/delegation/inBandSubagentRun';
import { describeSubagentProgress } from '@tools/delegation/subagentRun';
import { normalizeStructuredOutputSchema } from '@tools/structuredOutput';
import { toErrorMessage } from '@utils/errors/errorMessage';

const SelfInputSchema = z.strictObject({
  prompt: z
    .string()
    .min(1, 'prompt is required')
    .describe('What this run of you works on.'),
  fork: nullishWithDefault(z.boolean(), true).describe(
    'Continue this conversation as it stood when the script started, with `prompt` added to the message that started it; `false` starts from `prompt` alone.',
  ),
  schema: z
    .record(z.string(), z.unknown())
    .nullish()
    .describe(
      'A JSON Schema object: the run finishes by submitting a value of it, returned as `structured`.',
    ),
  label: z.string().nullish().describe('A short title for the call’s card.'),
});
type SelfInput = z.infer<typeof SelfInputSchema>;

/**
 * The conversation `self()` runs again, and the commit its forks cut before:
 * the caller itself, mid-turn in its script, or the conversation a
 * background script belongs to, as it stood when that script started.
 */
const conversationOf = Effect.fn('self.conversation')(function* (
  call: RunToolCall,
) {
  const { run } = call;
  if (run.config.script == null)
    return { source: run.runId, before: Number.POSITIVE_INFINITY };
  const start = (yield* run.session.log.records(run.runId)).find(
    (row) => row.type === 'run.start',
  );
  const parent = run.session.view.run(run.runId)?.parentId ?? null;
  if (start === undefined || parent === null)
    return yield* Effect.fail(
      new ToolError(
        `self() needs the conversation the script ${run.runId} belongs to.`,
      ),
    );
  return { source: parent, before: start.commit };
});

const runSelf = Effect.fn('self.call')(function* (
  call: RunToolCall,
  input: SelfInput,
) {
  const { run } = call;
  const { session, runId: parentRunId } = run;
  const { source, before } = yield* conversationOf(call);
  const config = yield* getRunRecords(session, source).readConfig();
  if (config === null)
    return errorResult(
      `The conversation ${source} has no stored configuration.`,
    );
  const name = config.agent;
  const outputSchema =
    input.schema == null
      ? undefined
      : yield* Effect.try({
          try: () =>
            normalizeStructuredOutputSchema(input.schema ?? {}).jsonSchema,
          catch: (error) =>
            new ToolError(
              `\`schema\` is not a supported object-root JSON Schema: ${toErrorMessage(error)}`,
            ),
        });
  const notify = (update: SubagentProgressUpdate): void => {
    const line = describeSubagentProgress(name, update);
    if (line) call.emit(`${line}\n`);
  };
  // An earlier attempt's child answers the call, or continues under its id.
  const recovered = yield* Effect.result(
    recoverAgentChild(call, { notify, running: (work) => work }),
  );
  if (Result.isFailure(recovered)) return failedResult(name, recovered.failure);
  if (recovered.success.kind === 'ended')
    return yield* childResult(call, name, recovered.success, undefined);

  const runId = agentChildRunId(call);
  const parentOffered = yield* offeredBy(run);
  const launched = yield* Effect.result(
    input.fork
      ? Effect.gen(function* () {
          yield* forkChild(session, source, before, {
            runId,
            parentRunId,
            parentCard: call.logId,
            parentCallId: call.callId,
            prompt: input.prompt,
            ...(outputSchema !== undefined && { outputSchema }),
            ...(input.label != null && {
              description: childRunDescription(input.label),
            }),
          });
          return yield* resumeSubagentInBand({
            session,
            runId,
            parentRunId,
            parentOffered,
            notify,
          });
        })
      : Effect.gen(function* () {
          const { rootUserInstruction: _root, ...launch } = config;
          const bound = yield* SynchronizedRef.get(run.model);
          return yield* executeSubagentInBand({
            session,
            runId,
            parentRunId,
            configPayload: AgentConfigSchema.parse({
              ...launch,
              script: null,
              model: bound.modelId,
              instruction: input.prompt,
              displayInstruction: null,
              outputFiles: [],
              outputSchema: outputSchema ?? null,
              cli: null,
            }),
            parentOffered,
            parentCard: call.logId,
            parentCallId: call.callId,
            notify,
          });
        }),
  );
  return Result.isFailure(launched)
    ? failedResult(name, launched.failure)
    : yield* childResult(call, name, launched.success, undefined);
});

/** The `self` function of a script. */
export const SelfTool = defineTool({
  name: 'self',
  // A resumed call finds the child its earlier attempt launched and settles
  // from it, or resumes it under its own id: it never launches a second one.
  replay: 'safe',
  // A script's calls run beside each other, held to the child-run budget.
  lane: 'own',
  // Offered with the script tool: only a script calls it.
  scriptGlobal: { positional: 'prompt', withScript: true },
  scriptReturns:
    "{ response: string; files: string[]; structured?: unknown; runId: string; outcome: 'completed'; cost: number }",
  slow: true,
  description: `Run yourself again on a prompt, as a child of this call, and wait for its result: \`{ response, files, structured?, runId, outcome, cost }\`.

Forked (the default), the child continues this conversation as it stood when the script started (the message of the turn that started it, not that turn's work so far), with \`prompt\` added to that message; with \`fork: false\` it starts from \`prompt\` alone. It is you with your tools and model: nothing is proposed or approved again. It rejects with an Error named \`AgentFailed\` or \`Skipped\` (the user stopped it). Call it from a script; called directly, it runs nothing.`,
  schema: SelfInputSchema,
  execute: (input: SelfInput) =>
    Effect.gen(function* () {
      const call = yield* requireToolRun('self');
      const script = yield* IssuingScript;
      if (script === null)
        return errorResult('self() runs only inside a script.');
      const budget = yield* scriptChildBudget(call.env.roots, script);
      return yield* budget.withPermits(1)(runSelf(call, input));
    }),
});
