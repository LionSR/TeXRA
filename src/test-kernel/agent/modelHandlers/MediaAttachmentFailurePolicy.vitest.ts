// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports
import { noopTrace, type AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import {
  type MediaAttachmentContext,
  reportMediaAttachmentFailure,
} from '@agent/modelHandlers/support/mediaAttachmentPolicy';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import type { FileLocation } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';
import { pathToLocation } from '@utils/files/fileLocation';

// pathToLocation resolves through platform services.
setupPlatform({}, { fs: nodeFilesystem });

function createFailureRecorder(): {
  logger: AgentTrace;
  errorMessages: string[];
  warnMessages: string[];
} {
  const errorMessages: string[] = [];
  const warnMessages: string[] = [];
  const logger: AgentTrace = {
    ...noopTrace,
    warn: (message: string) => {
      warnMessages.push(message);
    },
    error: (message: string) => {
      errorMessages.push(message);
    },
  };
  return { logger, errorMessages, warnMessages };
}

const MEDIA_FAILURE = new Error('media processing exploded');

class ThrowingMediaOpenAIResponseHandler extends ModelHandlerOpenAIResponse {
  protected override async createMediaMessage(): Promise<never> {
    throw MEDIA_FAILURE;
  }
}

class ThrowingMediaGoogleInteractionsHandler extends ModelHandlerGoogleInteractions {
  protected override async createMediaMessage(): Promise<never> {
    throw MEDIA_FAILURE;
  }
}

const OPENAI_RESPONSE_TEST_CONFIG = Object.freeze({
  name: 'gpt-4.1',
  fullName: 'gpt-4.1',
  shortName: 'gpt-4.1',
  label: 'GPT 4.1',
  provider: ModelProvider.OPENAI,
  capabilities: Object.freeze({ supportsVision: true }),
});

const GOOGLE_GENAI_TEST_CONFIG = Object.freeze({
  name: 'test-google',
  fullName: 'test-google',
  shortName: 'test-google',
  label: 'Test Google',
  provider: ModelProvider.GOOGLE,
  contextWindow: 100_000,
  capabilities: Object.freeze({ supportsVision: true }),
});

const MEDIA_FILES = [pathToLocation('/tmp/does-not-matter.png')];

/** The subset of the ModelHandler surface these policy tests exercise. */
type ThrowingMediaHandler = {
  setLogger(logger: AgentTrace): void;
  initializeMessages(
    userPrefix: string,
    userRequest: string,
    mediaFiles?: FileLocation[],
  ): Promise<unknown[]>;
  createRoundMessages(
    messages: never[],
    userMessage: string,
    mediaFiles?: FileLocation[],
  ): Promise<unknown[]>;
};

const THROWING_MEDIA_HANDLERS: Array<{
  name: string;
  create: () => ThrowingMediaHandler;
}> = [
  {
    name: 'OpenAIResponse',
    create: () =>
      new ThrowingMediaOpenAIResponseHandler(
        buildTestModelConfig(OPENAI_RESPONSE_TEST_CONFIG),
      ),
  },
  {
    name: 'Google Interactions',
    create: () =>
      new ThrowingMediaGoogleInteractionsHandler(
        buildTestModelConfig(GOOGLE_GENAI_TEST_CONFIG),
      ),
  },
];

/**
 * #7465 regression: media-attachment failure policy is now decided once
 * (`reportMediaAttachmentFailure` / `ModelHandler.createMediaForRound`)
 * instead of being re-derived per call site. Before this fix, two providers
 * diverged from every other provider's initial-vs-follow-up split:
 *  - OpenAIResponse.initializeMessages (an *initial* round) caught and
 *    warned instead of failing the round.
 *  - Google GenAI.createRoundMessages (a *follow-up* round) had no catch at
 *    all and threw, instead of warning and continuing.
 * Both now follow the single policy: initial rounds fail loudly, follow-up
 * rounds warn and continue without the attachment.
 */
describe('media attachment failure policy (#7465)', () => {
  it.each(THROWING_MEDIA_HANDLERS)(
    '$name initializeMessages fails the round on a media error',
    async ({ create }) => {
      const handler = create();
      handler.setLogger(createFailureRecorder().logger);

      await assert.rejects(
        handler.initializeMessages('prefix', 'request', MEDIA_FILES),
        (err: unknown) => err === MEDIA_FAILURE,
      );
    },
  );

  it.each(THROWING_MEDIA_HANDLERS)(
    '$name createRoundMessages warns and continues without the attachment',
    async ({ create }) => {
      const handler = create();
      const { logger, errorMessages } = createFailureRecorder();
      handler.setLogger(logger);

      const messages = await handler.createRoundMessages(
        [],
        'follow-up text',
        MEDIA_FILES,
      );

      assert.equal(messages.length, 1, 'round message should still be built');
      assert.ok(
        errorMessages.some((m) => m.includes('follow-up round')),
        'should emit one error-level trace entry describing the dropped attachment',
      );
    },
  );

  // Regression (Copilot review on #7499): centralizing the policy must not
  // silently escalate `toolAttachment` failures from warn to error. Prior
  // per-site behavior (e.g. anthropicTools.ts's upload loop) used
  // `logger.warn` — a transient upload-service hiccup on one attachment is
  // common enough that it shouldn't render as a red error in the progress
  // view, unlike followUp/insert media failures which do stay error-level.
  it.each<{
    kind: MediaAttachmentContext;
    warns: number;
    errors: number;
    excerpt?: string;
  }>([
    {
      kind: 'toolAttachment',
      warns: 1,
      errors: 0,
      excerpt: 'tool result attachment',
    },
    { kind: 'followUp', warns: 0, errors: 1 },
  ])(
    'reports a $kind failure at the preserved severity',
    ({ kind, warns, errors, excerpt }) => {
      const { logger, errorMessages, warnMessages } = createFailureRecorder();

      reportMediaAttachmentFailure(logger, kind, MEDIA_FAILURE);

      assert.equal(warnMessages.length, warns);
      assert.equal(errorMessages.length, errors);
      if (excerpt !== undefined) {
        assert.ok(warnMessages[0].includes(excerpt));
      }
    },
  );
});
