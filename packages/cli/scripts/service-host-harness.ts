// Validation harness: a window with no editor that attaches to the running
// TeXRA service offering `readDiagnostics`, the way an extension window
// does. `answer` answers each read with one diagnostic naming the file;
// `hang` never answers, so the validator can detach it mid-call. It prints
// `ATTACHED` once its attachment is up, `LINKED` each time its link
// reaches a service (a restart prints it again), and `CALLED <path>` per
// read, and runs until it is killed. `lm` also offers the editor's language
// models: it lists one Copilot model and streams every turn's reply
// (`HARNESS-COPILOT streamed this reply.`), refusing a turn prepared by
// another acquisition as the editor does, and prints `ACQUIRED` and
// `CALLED lmModels` / `lmPrepare` / `lmStream`. With
// `lm` or `start` it then starts a task on `<model>` itself, as a VS Code
// window launches one, and prints `STARTED <runId>` (`start` offers no
// models).
//
//   node service-host-harness.js <storageRoot> <workspace> <answer|hang|lm|start> [model]

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Effect, Stream, SubscriptionRef } from 'effect';

import { ModelError, TurnResultSchema, type Model } from '@texra-ai/llm';

import { AgentConfigSchema } from '@agent/runtime';
import { linkService } from '@texra/controllers/server/client';
import { attachWindowHost } from '@texra/controllers/server/windowHost';
import { generateRunId } from '@utils/core';

const [storageRoot, workspace, mode, model] = process.argv.slice(2);
if (storageRoot === undefined || workspace === undefined)
  throw new Error(
    'usage: service-host-harness <storageRoot> <workspace> <answer|hang|lm>',
  );

/** The editor model's reply, streamed in these pieces. */
const STREAMED = ['HARNESS-COPILOT streamed ', 'this reply.'];

const say = (line: string) =>
  Effect.sync(() => process.stdout.write(`${line}\n`));

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const link = yield* linkService(
        storageRoot,
        Effect.fail(
          new Error('The harness attaches to a running service only.'),
        ),
      );
      yield* Effect.forkScoped(
        Stream.runForEach(SubscriptionRef.changes(link.client), (client) =>
          client === null ? Effect.void : say('LINKED'),
        ),
      );
      yield* attachWindowHost(
        link,
        workspace,
        {
          readDiagnostics: (file) =>
            say(`CALLED ${file}`).pipe(
              Effect.andThen(
                mode === 'hang'
                  ? Effect.never
                  : Effect.succeed([
                      {
                        severity: 0 as const,
                        message: `HARNESS-DIAG in ${path.basename(file)}`,
                        range: {
                          start: { line: 2, character: 0 },
                          end: { line: 2, character: 4 },
                        },
                      },
                    ]),
              ),
            ),
          ...(mode === 'lm' && {
            languageModel: {
              selectModels: () =>
                say('CALLED lmModels').pipe(
                  Effect.as([
                    {
                      id: 'gpt-5.6-terra',
                      name: 'GPT-5.6 Terra',
                      family: 'gpt-5.6-terra',
                      vendor: 'copilot',
                      version: 'gpt-5.6-terra-harness',
                      maxInputTokens: 200_000,
                      access: 'allowed' as const,
                    },
                  ]),
                ),
              // One acquisition per call of `acquire`, as the editor's: a
              // turn streams only through the acquisition that prepared it.
              acquire: (configuration) =>
                Effect.gen(function* () {
                  const acquisitionId = randomUUID();
                  yield* say('ACQUIRED');
                  const origin = {
                    protocol: 'vscode-lm' as const,
                    codecVersion: 1,
                    requestedModel: configuration.requestedModel,
                    deployment: configuration.deployment,
                  };
                  return {
                    prepareTurn: (request) =>
                      say('CALLED lmPrepare').pipe(
                        Effect.as({
                          ...origin,
                          mode: 'foreground' as const,
                          acquisitionId,
                          system: request.system,
                          messages: request.messages,
                          tools: request.tools ?? [],
                          controls: {
                            justification: configuration.defaults.justification,
                            toolChoice: 'auto' as const,
                          },
                        }),
                      ),
                    streamTurn: (turn) =>
                      Stream.unwrap(
                        say('CALLED lmStream').pipe(
                          Effect.andThen(
                            turn.protocol === 'vscode-lm' &&
                              turn.acquisitionId === acquisitionId
                              ? Effect.succeed(
                                  Stream.fromIterable(
                                    STREAMED.map((text) => ({
                                      kind: 'delta' as const,
                                      part: 'text' as const,
                                      text,
                                    })),
                                  ).pipe(
                                    Stream.concat(
                                      Stream.succeed({
                                        kind: 'completed' as const,
                                        result: TurnResultSchema.parse({
                                          kind: 'editor',
                                          requestedOrigin: origin,
                                          providerResponseId: null,
                                          returnedModel: null,
                                          modelFingerprint: null,
                                          finishReason: null,
                                          usage: null,
                                          content: [
                                            {
                                              kind: 'message',
                                              content: [
                                                {
                                                  kind: 'text',
                                                  text: STREAMED.join(''),
                                                },
                                              ],
                                            },
                                          ],
                                        }),
                                      }),
                                    ),
                                  ),
                                )
                              : Effect.fail(
                                  new ModelError({
                                    kind: 'unsupported',
                                    message:
                                      'HARNESS-COPILOT: the prepared turn belongs to another acquisition.',
                                  }),
                                ),
                          ),
                        ),
                      ),
                  } satisfies Model;
                }),
            },
          }),
        },
        Stream.empty,
      );
      // The attachment is a stream the service opens on its side: give it
      // a moment before a task asks for it.
      yield* Effect.sleep('1 second');
      yield* say('ATTACHED');
      const client = yield* SubscriptionRef.get(link.client);
      if ((mode === 'lm' || mode === 'start') && client !== null) {
        const runId = yield* client['task.start']({
          workspace,
          runId: generateRunId(),
          config: AgentConfigSchema.parse({
            agent: 'echo_validation',
            agentSource: 'custom',
            model,
            inputFiles: [],
            contextFiles: [],
            instruction: 'Answer through the editor model.',
            workingDirectory: workspace,
          }),
          continues: null,
          preferHelperModel: false,
          ownApiKeyFallback: false,
          approvalPolicy: null,
          approveDelegatedWork: false,
        });
        yield* say(`STARTED ${runId}`);
      }
      return yield* Effect.never;
    }),
  ),
);
