/**
 * Zod schemas for progress view message types.
 * Types are derived from schemas using z.infer<> for single source of truth.
 *
 * @module progressView/messages
 */
import { z } from 'zod';

import { ProgressViewApprovalActions } from '@tools/approval/toolEditApproval';

// --- Base Schemas (composable building blocks) ---

/** Trimmed non-empty string for text inputs */
const TrimmedString = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1));

/** Stream identifier schema - used by most stream-related messages */
export const StreamIdSchema = z.string().min(1);

// --- Stream Management Messages ---

/** Message with a stream identifier */
export const StreamMessageSchema = z.object({
  stream: StreamIdSchema,
});
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

/** Message for switch stream command */
export const SwitchStreamMessageSchema = StreamMessageSchema;
export type SwitchStreamMessage = z.infer<typeof SwitchStreamMessageSchema>;

/** Message for delete stream command */
export const DeleteStreamMessageSchema = StreamMessageSchema;
export type DeleteStreamMessage = z.infer<typeof DeleteStreamMessageSchema>;

/** Message for stop stream command */
export const StopStreamMessageSchema = StreamMessageSchema;
export type StopStreamMessage = z.infer<typeof StopStreamMessageSchema>;

/** Message for run again command */
export const RunAgainMessageSchema = StreamMessageSchema;
export type RunAgainMessage = z.infer<typeof RunAgainMessageSchema>;

/** Message for run new command */
export const RunNewMessageSchema = StreamMessageSchema;
export type RunNewMessage = z.infer<typeof RunNewMessageSchema>;

/** Message for retry stream request */
export const RetryStreamRequestMessageSchema = StreamMessageSchema;
export type RetryStreamRequestMessage = z.infer<
  typeof RetryStreamRequestMessageSchema
>;

/** Message for cancel retry request */
export const CancelRetryRequestMessageSchema = StreamMessageSchema;
export type CancelRetryRequestMessage = z.infer<
  typeof CancelRetryRequestMessageSchema
>;

/** Message for diff stream command */
export const DiffStreamMessageSchema = StreamMessageSchema;
export type DiffStreamMessage = z.infer<typeof DiffStreamMessageSchema>;

/** Message for pack stream command */
export const PackStreamMessageSchema = StreamMessageSchema;
export type PackStreamMessage = z.infer<typeof PackStreamMessageSchema>;

/** Message for clean stream command */
export const CleanStreamMessageSchema = StreamMessageSchema;
export type CleanStreamMessage = z.infer<typeof CleanStreamMessageSchema>;

/** Message for restore state command */
export const RestoreStateMessageSchema = StreamMessageSchema;
export type RestoreStateMessage = z.infer<typeof RestoreStateMessageSchema>;

/** Message for open task storage command */
export const OpenTaskStorageMessageSchema = z.object({
  stream: StreamIdSchema.optional(),
});
export type OpenTaskStorageMessage = z.infer<
  typeof OpenTaskStorageMessageSchema
>;

// --- Sort and Filter Messages ---

/** Valid sort options for streams */
export const StreamSortOrderSchema = z
  .enum(['time', 'name', 'status'])
  .prefault('time');

/** Message for sort streams command */
export const SortStreamsMessageSchema = z.object({
  sortBy: StreamSortOrderSchema.optional(),
});
export type SortStreamsMessage = z.infer<typeof SortStreamsMessageSchema>;

/** Message for filter streams command */
export const FilterStreamsMessageSchema = z.object({
  filter: z.string().optional(),
});
export type FilterStreamsMessage = z.infer<typeof FilterStreamsMessageSchema>;

// --- Follow-Up Messages ---

/** Message for send follow-up command */
export const SendFollowUpMessageSchema = z.object({
  stream: StreamIdSchema,
  text: TrimmedString,
});
export type SendFollowUpMessage = z.infer<typeof SendFollowUpMessageSchema>;

/** Message for polish follow-up command */
export const PolishFollowUpMessageSchema = z.object({
  stream: StreamIdSchema,
  text: TrimmedString,
});
export type PolishFollowUpMessage = z.infer<typeof PolishFollowUpMessageSchema>;

// --- Information Messages ---

/** Message for show information message command */
export const ShowInformationMessageSchema = z.object({
  text: TrimmedString,
});
export type ShowInformationMessage = z.infer<
  typeof ShowInformationMessageSchema
>;

// --- Approval Action Messages ---

/** Message for tool edit approval action */
export const ToolEditApprovalActionMessageSchema = z.object({
  requestId: z.string().min(1),
  action: z.enum(ProgressViewApprovalActions),
  note: z.string().optional(),
});
export type ToolEditApprovalActionMessage = z.infer<
  typeof ToolEditApprovalActionMessageSchema
>;

// --- File Operation Messages ---

/** Base message with file path */
export const FileCommandMessageSchema = z.object({
  file: z.string(),
});
export type FileCommandMessage = z.infer<typeof FileCommandMessageSchema>;

/** Message with file and optional base path */
export const BaseFileCommandMessageSchema = FileCommandMessageSchema.extend({
  base: z.string().optional(),
});
export type BaseFileCommandMessage = z.infer<
  typeof BaseFileCommandMessageSchema
>;

/** Message for compare operations with optional previous file */
export const CompareMessageSchema = BaseFileCommandMessageSchema.extend({
  prev: z.string().optional(),
});
export type CompareMessage = z.infer<typeof CompareMessageSchema>;

// --- Label Messages ---

/** Message for open label command */
export const OpenLabelMessageSchema = z.object({
  label: z.string(),
});
export type OpenLabelMessage = z.infer<typeof OpenLabelMessageSchema>;
