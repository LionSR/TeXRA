// Third-party imports
import { z } from 'zod';

// Local imports - canonical protocol binding
import {
  ModelOriginSchema,
  OriginSchema,
  type ModelOrigin,
} from './protocol.js';

const TextPartSchema = z
  .strictObject({ kind: z.literal('text'), text: z.string() })
  .readonly();
const MediaFieldsSchema = z.strictObject({
  mimeType: z.string().min(1),
  // Encoding validity is distinct from a provider accepting the captured bytes.
  base64: z.base64(),
});
const InputPartSchema = z.discriminatedUnion('kind', [
  TextPartSchema,
  MediaFieldsSchema.extend({
    kind: z.literal('image'),
    detail: z.enum(['low', 'medium', 'high', 'ultra-high']).optional(),
  }).readonly(),
  MediaFieldsSchema.extend({
    kind: z.enum(['audio', 'video', 'document']),
  }).readonly(),
]);

const OpenRouterDetailMetadataSchema = z.strictObject({
  format: z.string().nullable().optional(),
  id: z.string().nullable().optional(),
  index: z.number().optional(),
});
const OpenRouterReasoningSchema = z
  .strictObject({
    kind: z.literal('openrouter-reasoning'),
    plain: z.string().nullable().optional(),
    details: z
      .array(
        z.discriminatedUnion('kind', [
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('text'),
            text: z.string().nullable().optional(),
            signature: z.string().nullable().optional(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('summary'),
            summary: z.string(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('encrypted'),
            data: z.string(),
          }).readonly(),
          OpenRouterDetailMetadataSchema.extend({
            kind: z.literal('server-tool-call'),
            toolName: z.string(),
            toolCallId: z.string().nullable().optional(),
            arguments: z.string(),
            result: z.string(),
          }).readonly(),
        ]),
      )
      .readonly()
      .optional(),
  })
  .refine(
    (evidence) =>
      evidence.plain !== undefined || evidence.details !== undefined,
    {
      message:
        'OpenRouter reasoning preserves a reported plain or details field.',
    },
  )
  .readonly();
const MiniMaxReasoningSchema = z
  .strictObject({
    kind: z.literal('minimax-reasoning'),
    plain: z.string().optional(),
    details: z
      .array(
        z
          .strictObject({
            type: z.string().optional(),
            id: z.string().optional(),
            format: z.string().optional(),
            index: z.int().optional(),
            text: z.string().optional(),
          })
          .readonly(),
      )
      .readonly()
      .optional(),
  })
  .refine(
    (evidence) =>
      evidence.plain !== undefined || evidence.details !== undefined,
    {
      message: 'MiniMax reasoning preserves a reported plain or details field.',
    },
  )
  .readonly();
export const MiniMaxDetectionSchema = z.strictObject({
  inputSensitive: z.boolean().optional(),
  inputSensitiveType: z.int().optional(),
  outputSensitive: z.boolean().optional(),
  outputSensitiveType: z.int().optional(),
  outputSensitiveInt: z.int().optional(),
});
const EvidenceStatusSchema = z.enum(['completed', 'incomplete']);
const MessagePartSchema = z.strictObject({
  kind: z.literal('message'),
  content: z
    .array(
      z.discriminatedUnion('kind', [
        TextPartSchema,
        z
          .strictObject({ kind: z.literal('refusal'), text: z.string() })
          .readonly(),
      ]),
    )
    .readonly(),
  evidence: z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('openai-responses-message'),
          itemId: z.string().min(1),
          status: EvidenceStatusSchema,
          phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('minimax-message'),
          name: z.string().optional(),
          audioContent: z.literal('').optional(),
        })
        .readonly(),
    ])
    .optional(),
});
const LocalCallPartSchema = z.strictObject({
  kind: z.literal('local-call'),
  providerCallId: z.string().min(1),
  name: z.string().min(1),
  /**
   * The provider's exact returned bytes, the one carrier of the arguments.
   * A JSON.parse then JSON.stringify round trip is not byte exact (it
   * truncates integers past 2^53, rewrites 1.0 as 1, collapses duplicate
   * keys and reorders integer-like keys), so the parse is never stored;
   * codecs parse these bytes where a request is lowered.
   */
  argumentsText: z.string(),
  evidence: z
    .discriminatedUnion('kind', [
      z
        .strictObject({
          kind: z.literal('openai-responses-function-call'),
          itemId: z.string().min(1).optional(),
          status: z.literal('completed').optional(),
        })
        .readonly(),
      z
        .strictObject({
          kind: z.literal('minimax-function-call'),
          index: z.int().optional(),
        })
        .readonly(),
    ])
    .optional(),
});

const OutputPartSchema = z.discriminatedUnion('kind', [
  MessagePartSchema.readonly(),
  z
    .strictObject({
      kind: z.literal('reasoning'),
      summary: z.array(TextPartSchema).readonly(),
      content: z.array(TextPartSchema).readonly().optional(),
      evidence: z
        .discriminatedUnion('kind', [
          OpenRouterReasoningSchema,
          MiniMaxReasoningSchema,
          z
            .strictObject({ kind: z.literal('chat-reasoning-content') })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('google-interactions-thought-signature'),
              signature: z.string().min(1),
            })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('openai-responses-reasoning'),
              itemId: z.string().min(1),
              // Missing, null and exact opaque bytes have distinct wire meanings.
              encryptedContent: z.string().nullable().optional(),
              status: EvidenceStatusSchema.optional(),
            })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('anthropic-thinking-signature'),
              signature: z.string(),
            })
            .readonly(),
          z
            .strictObject({
              kind: z.literal('anthropic-redacted-thinking'),
              data: z.string(),
            })
            .readonly(),
        ])
        .nullable(),
    })
    .readonly(),
  LocalCallPartSchema.readonly(),
]);

export const ContentSchema = z.array(OutputPartSchema).readonly();
export const EditorContentSchema = z
  .array(
    z.discriminatedUnion('kind', [
      MessagePartSchema.omit({ evidence: true })
        .extend({ content: z.array(TextPartSchema).readonly() })
        .readonly(),
      LocalCallPartSchema.omit({ evidence: true }).readonly(),
    ]),
  )
  .readonly();
export const EVIDENCE_PROTOCOL = {
  'google-interactions-thought-signature': 'google-interactions',
  'openai-responses-message': 'openai-responses',
  'openai-responses-reasoning': 'openai-responses',
  'openai-responses-function-call': 'openai-responses',
  'anthropic-thinking-signature': 'anthropic-messages',
  'anthropic-redacted-thinking': 'anthropic-messages',
  'openrouter-reasoning': 'openrouter-chat',
  'minimax-reasoning': 'minimax-chat',
  'minimax-message': 'minimax-chat',
  'minimax-function-call': 'minimax-chat',
  google: 'google-interactions',
  anthropic: 'anthropic-messages',
  xai: 'xai-chat',
  openrouter: 'openrouter-chat',
  minimax: 'minimax-chat',
  'google-interactions': 'google-interactions',
  'openai-responses': 'openai-responses',
} as const;

export function validateAssistantContent(
  origin: ModelOrigin,
  content: z.infer<typeof ContentSchema>,
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, part] of content.entries()) {
    const evidence = part.evidence;
    if (
      evidence != null &&
      (evidence.kind === 'chat-reasoning-content'
        ? ![
            'deepseek-chat',
            'kimi-chat',
            'glm-chat',
            'xai-chat',
            'dashscope-chat',
          ].includes(origin.protocol)
        : origin.protocol !== EVIDENCE_PROTOCOL[evidence.kind])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Provider content evidence requires its original protocol binding.',
      });
    }
    if (
      part.kind === 'reasoning' &&
      (((evidence?.kind === 'anthropic-thinking-signature' ||
        evidence?.kind === 'chat-reasoning-content') &&
        (part.summary.length !== 0 || part.content?.length !== 1)) ||
        ((evidence?.kind === 'anthropic-redacted-thinking' ||
          evidence?.kind === 'openrouter-reasoning' ||
          evidence?.kind === 'minimax-reasoning') &&
          (part.summary.length !== 0 || part.content !== undefined)))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index],
        message:
          'Signed or Chat thinking preserves one exact returned text field; redacted and grouped reasoning keep their content in provider evidence.',
      });
    }
    if (
      evidence != null &&
      'itemId' in evidence &&
      evidence.itemId !== undefined
    ) {
      if (itemIds.has(evidence.itemId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['content', index, 'evidence', 'itemId'],
          message: 'Provider item IDs must be distinct within one response.',
        });
      }
      itemIds.add(evidence.itemId);
    }
    if (part.kind !== 'local-call') continue;
    if (ids.has(part.providerCallId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['content', index, 'providerCallId'],
        message: 'Provider call IDs must be distinct within one response.',
      });
    }
    ids.add(part.providerCallId);
  }
}

const AssistantMessageSchema = z
  .strictObject({
    role: z.literal('assistant'),
    origin: ModelOriginSchema,
    content: ContentSchema,
  })
  .superRefine((message, ctx) => {
    if (message.origin.protocol === 'vscode-lm') {
      const parsed = EditorContentSchema.safeParse(message.content);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ ...issue, path: ['content', ...issue.path] });
        }
      }
    }
    validateAssistantContent(message.origin, message.content, ctx);
  })
  .readonly();
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;

export const MessageSchema = z.discriminatedUnion('role', [
  z
    .strictObject({
      role: z.literal('user'),
      content: z.array(InputPartSchema).min(1).readonly(),
    })
    .readonly(),
  AssistantMessageSchema,
  z
    .strictObject({
      role: z.literal('tool'),
      results: z
        .array(
          z
            .strictObject({
              callOrdinal: z.int().nonnegative(),
              status: z.enum(['success', 'error']),
              content: z.array(InputPartSchema).readonly(),
            })
            .readonly(),
        )
        .min(1)
        .readonly(),
    })
    .readonly(),
]);

// A completed assistant can precede settlement; only the next request requires it.
export const PreparedHistorySchema = z
  .array(MessageSchema)
  .min(1)
  .superRefine((messages, ctx) => {
    for (const [index, message] of messages.entries()) {
      if (message.role === 'assistant') {
        const calls = message.content.filter(
          (part) => part.kind === 'local-call',
        );
        if (calls.length === 0) continue;
        const results = messages[index + 1];
        if (
          results?.role !== 'tool' ||
          results.results.length !== calls.length ||
          !results.results.every(
            (result, ordinal) => result.callOrdinal === ordinal,
          )
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message:
              'Every local call requires one adjacent, complete, ordinal-ordered tool-result group before another generation.',
          });
        }
      } else if (message.role === 'tool') {
        const previous = messages[index - 1];
        if (
          previous?.role !== 'assistant' ||
          !previous.content.some((part) => part.kind === 'local-call')
        ) {
          ctx.addIssue({
            code: 'custom',
            path: [index],
            message:
              'Tool results require an immediately preceding calling assistant.',
          });
        }
      }
    }
  })
  .readonly();

const PrefixSchema = z.strictObject({
  coveredMessages: z.int().positive(),
  prefixFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});
export const GoogleContinuationSchema = PrefixSchema.extend({
  origin: OriginSchema.extend({
    protocol: z.literal('google-interactions'),
  }).readonly(),
  anchor: z
    .strictObject({
      interactionId: z.string().min(1),
      coveredSteps: z.int().positive(),
    })
    .readonly(),
}).readonly();
const ResponsesAnchorSchema = z.strictObject({
  responseId: z.string().min(1),
  coveredItems: z.int().nonnegative(),
});
export const ResponsesContinuationSchema = PrefixSchema.extend({
  origin: OriginSchema.extend({
    protocol: z.literal('openai-responses'),
  }).readonly(),
  // Only a stored anchor is durable. A connection-scoped anchor named a single
  // websocket, so it was dead the moment the process exited, and reusing a dead
  // one failed the whole turn rather than dropping the acceleration. Keeping it
  // representable here would let a persisted value carry it.
  anchor: ResponsesAnchorSchema.extend({
    kind: z.literal('stored'),
  }).readonly(),
}).readonly();
/** Provider acceleration of an exact prefix, never the conversation authority. */
export const ContinuationSchema = z.union([
  GoogleContinuationSchema,
  ResponsesContinuationSchema,
]);
export type Continuation = z.infer<typeof ContinuationSchema>;
