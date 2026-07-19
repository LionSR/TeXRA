// Third-party imports
import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

// Local imports - agent
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { noopTrace } from '@agent/trace/noopTrace';
import { GOOGLE_FINISH } from '@agent/types/StopReasonTypes';

// Local imports - test fixtures
import { buildTestModelConfig } from './testFixtures';

// Type imports
import type { Interactions } from '@google/genai';

type Step = Interactions.Step;

const GOOGLE_INTERACTIONS_TEST_CONFIG = {
  name: 'test-google-interactions',
  label: 'Test Google Interactions',
  fullName: 'gemini-3-pro-test',
  shortName: 'gemini-3-pro-test',
  provider: ModelProvider.GOOGLE,
  contextWindow: 4096,
  capabilities: { supportsVision: true, supportsTokenCounting: false },
};

function createHandler(): ModelHandlerGoogleInteractions {
  const handler = new ModelHandlerGoogleInteractions(
    buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG),
  );
  handler.setLogger({ ...noopTrace });
  return handler;
}

function textOf(step: Step): string {
  if (step.type !== 'user_input' && step.type !== 'model_output') return '';
  return (step.content ?? [])
    .filter((c): c is Interactions.TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('');
}

/** Stub the media loader so no platform / filesystem is touched. */
function stubImageMediaLoader(handler: ModelHandlerGoogleInteractions): void {
  (
    handler as unknown as {
      createMediaMessage: (files: unknown[]) => Promise<Interactions.Content[]>;
    }
  ).createMediaMessage = async () => [
    { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
  ];
}

describe('ModelHandlerGoogleInteractions message construction', () => {
  it('initializeMessages builds a single user_input step from prefix + request', async () => {
    const handler = createHandler();
    const steps = await handler.initializeMessages('PREFIX', 'REQUEST');
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('user_input');
    expect(textOf(steps[0])).toContain('PREFIX');
    expect(textOf(steps[0])).toContain('REQUEST');
  });

  it('createAssistantMessage builds a model_output step', () => {
    const handler = createHandler();
    const step = handler.createAssistantMessage('hi');
    expect(step.type).toBe('model_output');
    expect(textOf(step)).toBe('hi');
    expect(handler.extractAssistantText(step)).toBe('hi');
  });

  it('prependTextToUserMessage prepends into the trailing user_input step', () => {
    const handler = createHandler();
    const steps: Step[] = [
      { type: 'user_input', content: [{ type: 'text', text: 'body' }] },
    ];
    handler.prependTextToUserMessage(steps, 'stats');
    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect((content[0] as Interactions.TextContent).text).toBe('stats');
    expect((content[1] as Interactions.TextContent).text).toBe('body');
  });

  it('addMediaToUserMessage unshifts inline image content into the trailing user_input step', async () => {
    const handler = createHandler();
    const steps: Step[] = [
      { type: 'user_input', content: [{ type: 'text', text: 'caption' }] },
    ];

    stubImageMediaLoader(handler);

    await handler.addMediaToUserMessage(steps, [
      { absolutePath: '/x/fig.png' } as never,
    ]);

    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect(content[0]?.type).toBe('image');
    expect((content[1] as Interactions.TextContent).text).toBe('caption');
  });

  it('initializeMessages includes typed media content when mediaFiles are provided', async () => {
    const handler = createHandler();
    stubImageMediaLoader(handler);

    const steps = await handler.initializeMessages('PREFIX', 'REQUEST', [
      { absolutePath: '/x/fig.png' } as never,
    ]);

    expect(steps).toHaveLength(1);
    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect(content.some((c) => c.type === 'image')).toBe(true);
    // prefix + attached-files label + image + request, in order.
    expect((content[0] as Interactions.TextContent).text).toContain('PREFIX');
    expect(
      content.some(
        (c) =>
          c.type === 'text' &&
          /Attached/.test((c as Interactions.TextContent).text),
      ),
    ).toBe(true);
    expect(textOf(steps[0])).toContain('REQUEST');
  });

  it('uploadMediaEntries inlines data under the limit and uploads (uri) over it', async () => {
    // A handler whose inline limit is 4 bytes so the boundary is exercised
    // without allocating a 20 MB payload.
    class TinyInlineLimitHandler extends ModelHandlerGoogleInteractions {
      protected override getInlineUploadLimitBytes(): number {
        return 4;
      }
    }
    const handler = new TinyInlineLimitHandler(
      buildTestModelConfig(GOOGLE_INTERACTIONS_TEST_CONFIG),
    );
    handler.setLogger({ ...noopTrace });

    let uploadCalls = 0;
    (handler as unknown as { getClient: () => Promise<unknown> }).getClient =
      async () => ({
        files: {
          upload: async () => {
            uploadCalls += 1;
            return { uri: 'files/abc', mimeType: 'image/png' };
          },
        },
      });

    const entries = [
      // 2 bytes decoded (<= 4) → inline data.
      {
        file_name: 'small.png',
        media_type: 'image/png',
        data: Buffer.from('hi').toString('base64'),
      },
      // 11 bytes decoded (> 4) → falls back to upload → uri.
      {
        file_name: 'big.png',
        media_type: 'image/png',
        data: Buffer.from('hello world').toString('base64'),
        source_path: '/x/big.png',
        bytes_match_source: true,
      },
    ];

    const content = await (
      handler as unknown as {
        uploadMediaEntries: (e: unknown[]) => Promise<Interactions.Content[]>;
      }
    ).uploadMediaEntries(entries);

    expect(content).toHaveLength(2);
    const inline = content[0] as Interactions.ImageContent;
    expect(inline.type).toBe('image');
    expect(inline.data).toBeTruthy();
    expect(inline.uri).toBeUndefined();
    expect(inline.resolution).toBe('high');

    const uploaded = content[1] as Interactions.ImageContent;
    expect(uploaded.type).toBe('image');
    expect(uploaded.uri).toBe('files/abc');
    expect(uploaded.data).toBeUndefined();
    expect(uploaded.resolution).toBe('high');
    expect(uploadCalls).toBe(1);
  });

  it('builds typed Interactions media content for audio, video, and documents', async () => {
    const handler = createHandler();
    (handler as unknown as { getClient: () => Promise<unknown> }).getClient =
      async () => ({
        files: {
          upload: async () => {
            throw new Error('expected inline media');
          },
        },
      });

    const entries = [
      {
        file_name: 'sound.mp3',
        media_type: 'audio/mp3',
        data: Buffer.from('audio').toString('base64'),
      },
      {
        file_name: 'clip.mp4',
        media_type: 'video/mp4',
        data: Buffer.from('video').toString('base64'),
      },
      {
        file_name: 'paper.pdf',
        media_type: 'application/pdf',
        data: Buffer.from('pdf').toString('base64'),
      },
    ];

    const content = await (
      handler as unknown as {
        uploadMediaEntries: (e: unknown[]) => Promise<Interactions.Content[]>;
      }
    ).uploadMediaEntries(entries);

    expect(content).toEqual([
      {
        type: 'audio',
        data: Buffer.from('audio').toString('base64'),
        mime_type: 'audio/mp3',
      },
      {
        type: 'video',
        data: Buffer.from('video').toString('base64'),
        mime_type: 'video/mp4',
      },
      {
        type: 'document',
        data: Buffer.from('pdf').toString('base64'),
        mime_type: 'application/pdf',
      },
    ]);
  });

  it('counts typed media content instead of only text labels', async () => {
    const handler = createHandler();
    const countCalls: unknown[] = [];
    const total = await handler.estimateTokenCount(
      [
        {
          type: 'user_input',
          content: [
            { type: 'text', text: 'caption' },
            {
              type: 'image',
              data: Buffer.from('image').toString('base64'),
              mime_type: 'image/png',
              resolution: 'high',
            },
            {
              type: 'document',
              uri: 'files/paper',
              mime_type: 'application/pdf',
            },
          ],
        },
      ],
      {
        client: {
          models: {
            countTokens: async (params: unknown) => {
              countCalls.push(params);
              return { totalTokens: 123 };
            },
          },
        } as never,
      },
    );

    expect(total).toBe(123);
    expect(countCalls).toHaveLength(1);
    const request = countCalls[0] as {
      contents: Array<{ parts: unknown[] }>;
    };
    const parts = request.contents[0]?.parts as Array<
      | { text: string }
      | {
          inlineData?: { data: string; mimeType: string };
          fileData?: { fileUri: string; mimeType: string };
          mediaResolution?: { level: string };
        }
    >;
    expect(parts).toEqual([
      { text: 'caption' },
      {
        inlineData: {
          data: Buffer.from('image').toString('base64'),
          mimeType: 'image/png',
        },
        mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
      },
      {
        fileData: {
          fileUri: 'files/paper',
          mimeType: 'application/pdf',
        },
      },
    ]);
  });

  it('extractResponse walks model_output steps and appends endTag on completion', () => {
    const handler = createHandler();
    const response = {
      id: 'int',
      status: 'completed',
      steps: [
        { type: 'thought', summary: [{ type: 'text', text: 'ignore me' }] },
        {
          type: 'model_output',
          content: [{ type: 'text', text: 'answer body' }],
        },
      ],
    } as never;

    const extracted = handler.extractResponse(response, '</doc>');
    expect(extracted.text).toContain('answer body');
    expect(extracted.text).not.toContain('ignore me');
    expect(extracted.text.endsWith('</doc>')).toBe(true);
    // The Interactions 'completed' status is normalized to the canonical Google
    // STOP finish reason so shared stop logic reads it as a natural end-of-turn.
    expect(extracted.stopReason).toBe(GOOGLE_FINISH.STOP);
  });

  it('maps a completed interaction to endTurn (not a spurious cancellation)', () => {
    // Regression: a background/non-streaming Interactions response that finished
    // cleanly on the document end tag was returning the raw 'completed' status,
    // which is not in `endTurnReasons` — so checkStopConditions yielded
    // endTurn=false while encounterDocumentTag forced shouldStop=true. The
    // ResponseCycle then read `shouldStop && !endTurn` as a user cancellation
    // and discarded the already-generated output. The status must normalize to
    // GOOGLE_FINISH.STOP so endTurn=true.
    const handler = createHandler();
    const response = {
      id: 'int',
      status: 'completed',
      steps: [
        {
          type: 'model_output',
          content: [{ type: 'text', text: 'body</documents>' }],
        },
      ],
    } as never;

    const { stopReason, text } = handler.extractResponse(
      response,
      '</documents>',
    );
    const setting = {} as never;
    const round = { continuationCount: 0 } as never;
    const global = {
      usageAccumulator: {
        totals: {
          firstInputTokens: 100,
          totalInputTokens: 100,
          totalOutputTokens: 50,
        },
      },
    } as never;

    const { endTurn, shouldStop } = handler.checkStopConditions(
      stopReason,
      text,
      round,
      global,
      setting,
    );
    expect(shouldStop).toBe(true);
    expect(endTurn).toBe(true);
  });
});
