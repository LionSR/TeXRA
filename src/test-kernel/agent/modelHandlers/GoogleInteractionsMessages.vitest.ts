// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { noopTrace } from '@agent/trace';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { GOOGLE_FINISH } from '@agent/types/StopReasonTypes';
import type { MediaEntry } from '@agent/types/mediaTypes';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// Local file imports
import {
  GOOGLE_INTERACTIONS_TEST_CONFIG,
  userStep,
} from './googleInteractionsTestUtils';

// Third-party imports
import type { GoogleGenAI, Interactions } from '@google/genai';

type Step = Interactions.Step;

const MESSAGES_TEST_CONFIG = Object.freeze({
  ...GOOGLE_INTERACTIONS_TEST_CONFIG,
  capabilities: Object.freeze({
    supportsVision: true,
    supportsTokenCounting: false,
  }),
});

function createHandler(): ModelHandlerGoogleInteractions {
  const handler = new ModelHandlerGoogleInteractions(
    buildTestModelConfig(MESSAGES_TEST_CONFIG),
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

/**
 * A handler test double that stubs the media pipeline through typed seams:
 * canned media replaces the filesystem-backed loader, a canned client
 * replaces the credential-resolving factory, and the protected upload
 * pipeline is exposed directly. A private-member rename now fails
 * compilation instead of silently breaking the suite.
 */
class MediaProbeHandler extends ModelHandlerGoogleInteractions {
  private stubbedMedia: Interactions.Content[] = [];

  /** Canned media the loader override returns, so no platform/fs is touched. */
  setMediaContent(content: Interactions.Content[]): void {
    this.stubbedMedia = content;
  }

  /** Replace the client factory with a canned client (e.g. files.upload stub). */
  setClient(client: GoogleGenAI): void {
    this.getClient = () => Promise.resolve(client);
  }

  /** Invoke the media-upload pipeline directly. */
  uploadEntries(entries: MediaEntry[]): Promise<Interactions.Content[]> {
    return this.uploadMediaEntries(entries);
  }

  protected override async createMediaMessage(): Promise<
    Interactions.Content[]
  > {
    return this.stubbedMedia;
  }
}

function createMediaProbe(): MediaProbeHandler {
  const handler = new MediaProbeHandler(
    buildTestModelConfig(MESSAGES_TEST_CONFIG),
  );
  handler.setLogger({ ...noopTrace });
  return handler;
}

describe('ModelHandlerGoogleInteractions message construction', () => {
  it('initializeMessages builds a single user_input step from prefix + request', async () => {
    const handler = createHandler();
    const steps = await handler.initializeMessages('PREFIX', 'REQUEST');
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('user_input');
    expect(textOf(steps[0])).toBe('PREFIX\nREQUEST');
  });

  it('omits an empty prefix instead of sending an invalid text block', async () => {
    const handler = createHandler();
    const steps = await handler.initializeMessages('', 'What are we lacking?');

    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect(content).toEqual([{ type: 'text', text: 'What are we lacking?' }]);
  });

  it('rejects an initial message with no content', async () => {
    const handler = createHandler();
    await expect(handler.initializeMessages(' ', '\n')).rejects.toThrow(
      'Google messages require a non-empty user prefix, request, or attachment.',
    );
  });

  it('rejects a follow-up round with no content', async () => {
    const handler = createHandler();
    await expect(handler.createRoundMessages([], ' ')).rejects.toThrow(
      'Google follow-up messages require non-empty text or an attachment.',
    );
  });

  it('createAssistantMessage builds a model_output step', () => {
    const handler = createHandler();
    const step = handler.createAssistantMessage('hi');
    expect(step.type).toBe('model_output');
    expect(textOf(step)).toBe('hi');
    expect(handler.extractAssistantText(step)).toBe('hi');
  });

  it('rejects empty text when constructing a content block', () => {
    const handler = createHandler();
    expect(() => handler.createAssistantMessage('')).toThrow(
      'Google text content must not be empty.',
    );
  });

  it('does not append an empty follow-up text block', async () => {
    const handler = createHandler();
    const steps: Step[] = [userStep('body')];
    await handler.createUserFollowUpMessages(steps, '');
    expect(steps).toEqual([userStep('body')]);
  });

  it('prependTextToUserMessage prepends into the trailing user_input step', () => {
    const handler = createHandler();
    const steps: Step[] = [userStep('body')];
    handler.prependTextToUserMessage(steps, 'stats');
    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect((content[0] as Interactions.TextContent).text).toBe('stats');
    expect((content[1] as Interactions.TextContent).text).toBe('body');
  });

  it('addMediaToUserMessage unshifts inline image content into the trailing user_input step', async () => {
    const handler = createMediaProbe();
    const steps: Step[] = [userStep('caption')];

    handler.setMediaContent([
      { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
    ]);

    await handler.addMediaToUserMessage(steps, [
      { absolutePath: '/x/fig.png' } as never,
    ]);

    const content = (steps[0] as Interactions.UserInputStep).content ?? [];
    expect(content[0]?.type).toBe('image');
    expect((content[1] as Interactions.TextContent).text).toBe('caption');
  });

  it('creates a new user turn for an image-only follow-up', async () => {
    const handler = createMediaProbe();
    const steps: Step[] = [
      userStep('question'),
      { type: 'model_output', content: [{ type: 'text', text: 'answer' }] },
    ];
    handler.setMediaContent([
      { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
    ]);

    await handler.createUserFollowUpMessages(steps, '');
    await handler.addMediaToUserMessage(steps, [
      { absolutePath: '/x/follow-up.png' } as never,
    ]);

    expect(steps).toHaveLength(3);
    expect(steps[2]).toEqual({
      type: 'user_input',
      content: [{ type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' }],
    });
  });

  it('initializeMessages includes typed media content when mediaFiles are provided', async () => {
    const handler = createMediaProbe();
    handler.setMediaContent([
      { type: 'image', data: 'aGVsbG8=', mime_type: 'image/png' },
    ]);

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
    class TinyInlineLimitProbe extends MediaProbeHandler {
      protected override getInlineUploadLimitBytes(): number {
        return 4;
      }
    }
    const handler = new TinyInlineLimitProbe(
      buildTestModelConfig(MESSAGES_TEST_CONFIG),
    );
    handler.setLogger({ ...noopTrace });

    let uploadCalls = 0;
    handler.setClient({
      files: {
        upload: async () => {
          uploadCalls += 1;
          return { uri: 'files/abc', mimeType: 'image/png' };
        },
      },
    } as unknown as GoogleGenAI);

    const entries: MediaEntry[] = [
      // 2 bytes decoded (<= 4) → inline data.
      {
        file_name: 'small.png',
        media_type: 'image/png',
        media_category: 'image',
        data: Buffer.from('hi').toString('base64'),
      },
      // 11 bytes decoded (> 4) → falls back to upload → uri.
      {
        file_name: 'big.png',
        media_type: 'image/png',
        media_category: 'image',
        data: Buffer.from('hello world').toString('base64'),
        source_path: '/x/big.png',
        bytes_match_source: true,
      },
    ];

    const content = await handler.uploadEntries(entries);

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
    const handler = createMediaProbe();
    handler.setClient({
      files: {
        upload: async () => {
          throw new Error('expected inline media');
        },
      },
    } as unknown as GoogleGenAI);

    const entries: MediaEntry[] = [
      {
        file_name: 'sound.mp3',
        media_type: 'audio/mp3',
        media_category: 'audio',
        data: Buffer.from('audio').toString('base64'),
      },
      {
        file_name: 'clip.mp4',
        media_type: 'video/mp4',
        media_category: 'video',
        data: Buffer.from('video').toString('base64'),
      },
      {
        file_name: 'paper.pdf',
        media_type: 'application/pdf',
        media_category: 'document',
        data: Buffer.from('pdf').toString('base64'),
      },
    ];

    const content = await handler.uploadEntries(entries);

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
