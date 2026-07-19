// Standard library imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

// Local imports - platform
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

// Local imports - test support
import { setupPlatform } from '@test/support/setupPlatform';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { ModelHandlerOpenAIResponse } from '@agent/modelHandlers/openai/modelHandlerOpenAIResponse';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { reportMediaAttachmentFailure } from '@agent/modelHandlers/support/mediaAttachmentPolicy';
import { noopTrace } from '@agent/trace/noopTrace';

// Type imports
import { pathToLocation } from '@utils/files';

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

class ThrowingMediaGoogleGenAIHandler extends ModelHandlerGoogleGenAI {
  protected override async createMediaMessage(): Promise<never> {
    throw MEDIA_FAILURE;
  }
}

function buildOpenAIResponseConfig(): ModelConfig {
  return {
    name: 'gpt-4.1',
    fullName: 'gpt-4.1',
    shortName: 'gpt-4.1',
    label: 'GPT 4.1',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsVision: true,
    },
    openRouterOnly: false,
  };
}

function buildGoogleGenAIConfig(): ModelConfig {
  return {
    name: 'test-google',
    fullName: 'test-google',
    shortName: 'test-google',
    label: 'Test Google',
    provider: ModelProvider.GOOGLE,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 100000,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsVision: true,
    },
    openRouterOnly: false,
  };
}

const MEDIA_FILES = [pathToLocation('/tmp/does-not-matter.png')];

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
  it('OpenAIResponse.initializeMessages now fails the round on a media error (previously silently warned)', async () => {
    const handler = new ThrowingMediaOpenAIResponseHandler(
      buildOpenAIResponseConfig(),
    );
    const { logger } = createFailureRecorder();
    handler.setLogger(logger);

    await assert.rejects(
      handler.initializeMessages('prefix', 'request', MEDIA_FILES),
      (err: unknown) => err === MEDIA_FAILURE,
    );
  });

  it('OpenAIResponse.createRoundMessages still warns and continues without the attachment', async () => {
    const handler = new ThrowingMediaOpenAIResponseHandler(
      buildOpenAIResponseConfig(),
    );
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
  });

  it('Google GenAI.createRoundMessages now warns and continues on a media error (previously threw and failed the round)', async () => {
    const handler = new ThrowingMediaGoogleGenAIHandler(
      buildGoogleGenAIConfig(),
    );
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
  });

  it('Google GenAI.initializeMessages still fails the round on a media error', async () => {
    const handler = new ThrowingMediaGoogleGenAIHandler(
      buildGoogleGenAIConfig(),
    );
    const { logger } = createFailureRecorder();
    handler.setLogger(logger);

    await assert.rejects(
      handler.initializeMessages('prefix', 'request', MEDIA_FILES),
      (err: unknown) => err === MEDIA_FAILURE,
    );
  });

  // Regression (Copilot review on #7499): centralizing the policy must not
  // silently escalate `toolAttachment` failures from warn to error. Prior
  // per-site behavior (e.g. anthropicTools.ts's upload loop) used
  // `logger.warn` — a transient upload-service hiccup on one attachment is
  // common enough that it shouldn't render as a red error in the progress
  // view, unlike followUp/insert media failures which do stay error-level.
  it('reports a toolAttachment failure as a warning, not an error', () => {
    const { logger, errorMessages, warnMessages } = createFailureRecorder();

    reportMediaAttachmentFailure(logger, 'toolAttachment', MEDIA_FAILURE);

    assert.equal(errorMessages.length, 0);
    assert.equal(warnMessages.length, 1);
    assert.ok(warnMessages[0].includes('tool result attachment'));
  });

  it('still reports a followUp failure as an error', () => {
    const { logger, errorMessages, warnMessages } = createFailureRecorder();

    reportMediaAttachmentFailure(logger, 'followUp', MEDIA_FAILURE);

    assert.equal(warnMessages.length, 0);
    assert.equal(errorMessages.length, 1);
  });
});
