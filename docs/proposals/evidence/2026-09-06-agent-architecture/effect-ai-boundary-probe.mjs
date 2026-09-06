import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Offline study probe against an installed Effect package. All model output
// is supplied by a fake provider; no credentials, network, or paid calls.
const root = process.argv[2];
if (!root)
  throw new Error('Usage: node effect-ai-boundary-probe.mjs DEPENDENCIES');
const require = createRequire(path.join(root, 'package.json'));
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { Effect, Stream } = await load('effect');
const LanguageModel = await load('effect/unstable/ai/LanguageModel');
const Response = await load('effect/unstable/ai/Response');
const Tool = await load('effect/unstable/ai/Tool');
const Toolkit = await load('effect/unstable/ai/Toolkit');

const input = { value: 'opaque input remains unchanged' };
let providerCalls = 0;
let handlerCalls = 0;
const tool = Tool.dynamic('record', {
  description: 'Offline observation counter',
  parameters: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
});
const toolkit = Toolkit.make(tool);
const handlerLayer = toolkit.toLayer({
  record: (params) =>
    Effect.sync(() => {
      handlerCalls += 1;
      return params;
    }),
});
const makeParts = () => {
  providerCalls += 1;
  return [
    Response.makePart('tool-call', {
      id: 'call-1',
      name: 'record',
      params: input,
      providerExecuted: false,
    }),
  ];
};
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.sync(makeParts),
      streamText: () => Stream.suspend(() => Stream.fromIterable(makeParts())),
    });
    const controlled = yield* model.generateText({
      prompt: 'Use the tool',
      toolkit,
      disableToolCallResolution: true,
    });
    assert.equal(providerCalls, 1);
    assert.equal(handlerCalls, 0);
    assert.deepEqual(controlled.toolCalls[0].params, input);
    const automatic = yield* model
      .generateText({ prompt: 'Use the tool', toolkit })
      .pipe(Effect.provide(handlerLayer));
    assert.equal(providerCalls, 2);
    assert.equal(handlerCalls, 1);
    assert.ok(automatic.content.some((part) => part.type === 'tool-result'));
    return {
      effectVersion: require('effect/package.json').version,
      controlled: {
        providerCalls: 1,
        handlerCalls: 0,
        handlerLayerProvided: false,
        inputPreserved: true,
      },
      automatic: { providerCalls: 1, handlerCalls: 1, toolResultPresent: true },
      interpretation:
        'One generation resolves tools by default but does not perform the next model turn. Disabling resolution leaves tool execution with the application. This does not validate a TeXRA provider integration or durability.',
    };
  }),
);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
