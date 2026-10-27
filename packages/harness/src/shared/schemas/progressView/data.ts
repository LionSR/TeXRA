/**
 * ProgressView shared field schemas and data payload schemas. These carry no
 * IPC `command` wrapper so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { Schema } from 'effect';

import {
  AgentProposalPermissionSchema,
  BashPermissionSchema,
  ExternalInquiryPermissionSchema,
  PlanApprovalPermissionSchema,
  RetryPermissionSchema,
  ToolEditPermissionSchema,
  UserQuestionPermissionSchema,
} from '../prompts';
import { ScriptDeliverySummarySchema } from '../scriptDelivery';

// ============================================================
// Shared Field Schemas
// ============================================================

/** Coarse media-attachment classification: `image` vs everything else. */
export const MediaAttachmentKindSchema = Schema.Literals(['image', 'document']);
export type MediaAttachmentKind = typeof MediaAttachmentKindSchema.Type;

/**
 * `userMessage` row payload: attachment kind + count only — never
 * bytes — so the archived conversation can render `[image attachment]` /
 * `[document attachment]` markers for media that was sent to the model but
 * only ever lived in the provider message, not the transcript row.
 * `mediaFiles` are the files a follow-up attached, as its send named them,
 * so "Fork from here" puts them back in the fork's composer beside the text.
 * `scriptSummary` carries a workflow delivery's typed presentation facts
 * beside the rendered text, so the progress view renders structured data
 * instead of re-parsing it out of the row text.
 */
export const UserMessagePayloadSchema = Schema.Struct({
  attachments: Schema.optional(Schema.Array(MediaAttachmentKindSchema)),
  mediaFiles: Schema.optional(Schema.Array(Schema.String)),
  scriptSummary: Schema.optional(ScriptDeliverySummarySchema),
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
export const ToolCallStatusSchema = Schema.Enum(TOOL_CALL_STATUS);
export type ToolCallStatus = typeof ToolCallStatusSchema.Type;

/**
 * A card a tool states itself instead of one the fold derives from its tool
 * name: what a plugin reporting an external agent's work (a patch, a thread,
 * a turn) shows. Plain data in the generic section kinds every renderer
 * already paints, so the fold stays plugin-agnostic.
 */
export const ToolCardSchema = Schema.Struct({
  /** The row header, in place of the tool's display name. */
  title: Schema.String,
  sections: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('text'),
        label: Schema.String,
        text: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal('status'),
        label: Schema.String,
        status: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal('identifier'),
        label: Schema.String,
        value: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal('badges'),
        label: Schema.String,
        badges: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal('fileList'),
        label: Schema.String,
        files: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            note: Schema.optional(Schema.String),
          }),
        ),
      }),
    ]),
  ),
});
/** A card a tool states itself (`ToolCardSchema`). */
export type ToolCard = typeof ToolCardSchema.Type;

/**
 * An MCP tool call's output: its status, its structured content, and its
 * content blocks. A server need not emit this shape; the tool row shows
 * output that does not parse as it came.
 */
export const McpToolOutputSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(Schema.String)),
  structuredContent: Schema.optional(Schema.NullOr(Schema.Unknown)),
  contentBlocks: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  ),
});
/** The output an MCP tool call reports (`McpToolOutputSchema`). */
export type McpToolOutput = typeof McpToolOutputSchema.Type;

export const ToolUseLogSchema = Schema.Struct({
  toolName: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  userInstruction: Schema.optional(Schema.String),
  /** The one spelling of a command row's exit code: the builder that owns the
   *  code states it here, and renderers read it instead of scraping prose. */
  exitCode: Schema.optional(Schema.Int),
  status: Schema.optional(ToolCallStatusSchema),
  card: Schema.optional(ToolCardSchema),
});
export type ToolUseLog = typeof ToolUseLogSchema.Type;

/**
 * The flat, renderer-friendly tool-use view `normalizeToolUse`
 * derives from a parsed {@link ToolUseLog}. Declared as a
 * plain type, not a schema: the producer builds this shape field-by-field and
 * nothing ever parses it, so a schema would own no boundary.
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
  card?: ToolCard;
};

export const WebSearchPayloadSchema = Schema.Struct({
  query: Schema.optional(Schema.String),
});

/** What a pending request shows (diff, command, question), never host
 *  handles: the payload of `request.opened`. */
export const PermissionPayloadSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('toolEdit'),
    data: ToolEditPermissionSchema,
  }),
  Schema.Struct({ kind: Schema.Literal('bash'), data: BashPermissionSchema }),
  Schema.Struct({ kind: Schema.Literal('retry'), data: RetryPermissionSchema }),
  Schema.Struct({
    kind: Schema.Literal('proposal'),
    data: AgentProposalPermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('planApproval'),
    data: PlanApprovalPermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('externalInquiry'),
    data: ExternalInquiryPermissionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('userQuestion'),
    data: UserQuestionPermissionSchema,
  }),
]);
export type PermissionPayload = typeof PermissionPayloadSchema.Type;
/**
 * The one request kind vocabulary, read off the payload union. The
 * `request.opened` fact and every surface that lists pending requests key
 * off it, so a spelling that drifts fails to compile.
 */
export type ProgressPermissionKind = PermissionPayload['kind'];
/**
 * Whether a request parks the tool that opened it. Every kind does but the
 * external inquiry: its tool returns `dispatched` at once and the run carries
 * on, so the answer arrives as a follow-up instead of releasing a parked
 * fiber. Both folds read the distinction off this one predicate - the run
 * fold to decide which open requests a snapshot may leave unbound, the
 * session fold to decide which ones make a run wait on its user.
 */
export function requestParksItsCaller(
  payload: Pick<PermissionPayload, 'kind'>,
): boolean {
  return payload.kind !== 'externalInquiry';
}
