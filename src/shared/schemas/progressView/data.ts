/**
 * ProgressView shared field schemas and data payload schemas. These carry no
 * IPC `command` wrapper so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { z } from 'zod';

import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';

import {
  AgentOptionDataSchema,
  ModelOptionDataSchema,
} from '../mainView/state';
import {
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  ExternalInquiryPermissionSchema,
  PlanApprovalPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
  UserQuestionPermissionSchema,
} from '../prompts';
import { WorkflowScriptDeliverySummarySchema } from '../workflowScriptDelivery';

// ============================================================
// Shared Field Schemas
// ============================================================

export const MissingOutputsPayloadSchema = z.object({
  missing: z.array(z.string()).prefault([]),
  xmlFile: z.string().nullable().prefault(null),
});

/**
 * Coarse media-attachment classification: `image` vs everything else. Matches
 * the `image-attachment` / `document-attachment` split that
 * `normalizeConversationForExport` turns into export attachment parts.
 */
const MediaAttachmentKindSchema = z.enum(['image', 'document']);
export type MediaAttachmentKind = z.infer<typeof MediaAttachmentKindSchema>;

/**
 * `userMessage` row payload (#7508): attachment kind + count only — never
 * bytes — so the archived conversation can render `[image attachment]` /
 * `[document attachment]` markers for media that was sent to the model but
 * only ever lived in the provider message, not the transcript row.
 * `workflowSummary` carries a workflow delivery's typed presentation facts
 * beside the rendered text, so the progress view renders structured data
 * instead of re-parsing it out of the row text.
 */
export const UserMessagePayloadSchema = z.object({
  attachments: z.array(MediaAttachmentKindSchema).optional(),
  workflowSummary: WorkflowScriptDeliverySummarySchema.optional(),
});

/**
 * The one status of a tool call: carried by `tool.end`, folded onto the
 * card, and read by every renderer. A failed call is `failed`; there is no
 * side-channel error flag beside it.
 */
export const TOOL_CALL_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export const ToolCallStatusSchema = z.enum(TOOL_CALL_STATUS);
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;

export const ToolUseLogSchema = z.object({
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  spillPath: z.string().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  userInstruction: z.string().optional(),
  status: ToolCallStatusSchema.optional(),
});
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

/**
 * The flat, renderer-friendly tool-use view `normalizeToolUseData`
 * (`@shared/toolUse`) derives from a parsed {@link ToolUseLog}. Declared as a
 * plain type, not a schema: the producer builds this shape field-by-field and
 * nothing ever parses it, so a Zod schema would own no boundary.
 */
export type NormalizedToolUse = {
  toolName: string;
  errorText: string;
  outputText: string;
  exitCode?: number;
  userInstructionText: string;
  input: unknown;
  isUserFeedback: boolean;
  headerSummary: string;
  status?: ToolCallStatus;
};

// ============================================================
// URL Sanitization
// ============================================================

/** URL field for tool payloads that will be rendered as live links. */
const SafeUrlSchema = z.string().transform(sanitizeLiveLinkUrl);

/**
 * Render-boundary projection of the canonical provider web-search entry
 * (`WebSearchResult['results'][number]` in `@agent/types/ServerTools`). The
 * schema is not imported here because the shared layer must not depend on the
 * agent layer. It keeps only the rendered fields, all optional because
 * persisted archives may be partial, and applies the SafeUrl sanitization
 * transform to `url` at this boundary (#7230). Named for its payload so it no
 * longer collides with the agent layer's same-name schemas (#10279).
 */
const WebSearchPayloadItemSchema = z.object({
  url: SafeUrlSchema.optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
});

export const WebSearchPayloadSchema = z.object({
  query: z.string().optional(),
  results: z.array(WebSearchPayloadItemSchema).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});

export const WebFetchPayloadSchema = z.object({
  url: SafeUrlSchema.optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
  /** Fetched document text, size-capped at the source (#7508). */
  content: z.string().optional(),
});

/** What a pending approval shows (diff, command, question), never host
 *  handles: the payload of `approval.requested`. */
export const PermissionPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('toolEdit'), data: ToolEditPermissionSchema }),
  z.object({ kind: z.literal('bash'), data: BashPermissionSchema }),
  z.object({ kind: z.literal('retry'), data: RetryPermissionSchema }),
  z.object({
    kind: z.literal('proposal'),
    data: AgentProposalPermissionSchema,
    modelOptionsData: z.array(ModelOptionDataSchema).optional(),
    agentOptionsData: z.array(AgentOptionDataSchema).optional(),
  }),
  z.object({
    kind: z.literal('planApproval'),
    data: PlanApprovalPermissionSchema,
  }),
  z.object({
    kind: z.literal('externalInquiry'),
    data: ExternalInquiryPermissionSchema,
  }),
  z.object({
    kind: z.literal('userQuestion'),
    data: UserQuestionPermissionSchema,
  }),
]);
export type PermissionPayload = z.infer<typeof PermissionPayloadSchema>;
/**
 * The one approval/prompt kind vocabulary, read off the payload union. The
 * `approval.requested` fact, the runtime host-interaction kinds, and the CLI
 * approval queue all key off it, so a spelling that drifts fails to compile.
 */
export type ProgressPermissionKind = PermissionPayload['kind'];
