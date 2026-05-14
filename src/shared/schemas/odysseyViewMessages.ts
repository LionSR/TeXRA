/**
 * Schema definitions for OdysseyView messages.
 *
 * Outbound: backend → frontend (ODYSSEY_UPDATED).
 * Inbound: frontend → backend (START_ODYSSEY, PAUSE_ODYSSEY, RESUME_ODYSSEY,
 *   ABANDON_ODYSSEY, EDIT_OBJECTIVE, GET_ODYSSEY_STATUS, GET_ODYSSEY_LIST).
 *
 * Mirrors `memoryViewMessages.ts`. The same schemas are reused by the
 * desktop host and the future CLI `texra odyssey` subcommand.
 */
import { z } from 'zod';

import { ODYSSEY_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
// Import the data schema directly from its leaf module so this file (which
// is consumed by webview frontends via @shared/schemas) does not pull in
// the runtime modules re-exported by the @tools/odyssey barrel
// (OdysseyTool, OdysseyStore, platform-dependent code).
import { OdysseySchema } from '@tools/odyssey/odysseyMeta';

import { StreamTabIdSchema } from './identifiers';
import { commandOnly } from './messageFactories';

// ============================================================
// Outbound (backend → frontend)
// ============================================================

export const OdysseyUpdatedMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.ODYSSEY_UPDATED),
  /** Null when the record was deleted/abandoned and removed from index. */
  odyssey: OdysseySchema.nullable(),
  streamId: StreamTabIdSchema,
});
export type OdysseyUpdatedMessage = z.infer<typeof OdysseyUpdatedMessageSchema>;

// ============================================================
// Inbound (frontend → backend)
// ============================================================

export const GetOdysseyStatusMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.GET_ODYSSEY_STATUS),
  streamId: StreamTabIdSchema,
});
export type GetOdysseyStatusMessage = z.infer<
  typeof GetOdysseyStatusMessageSchema
>;

export const GetOdysseyListMessageSchema = commandOnly(
  ODYSSEY_VIEW_COMMANDS.GET_ODYSSEY_LIST,
);

export const StartOdysseyMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.START_ODYSSEY),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
});
export type StartOdysseyMessage = z.infer<typeof StartOdysseyMessageSchema>;

export const PauseOdysseyMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.PAUSE_ODYSSEY),
  streamId: StreamTabIdSchema,
  reason: z.string().nullish(),
});
export type PauseOdysseyMessage = z.infer<typeof PauseOdysseyMessageSchema>;

export const ResumeOdysseyMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.RESUME_ODYSSEY),
  streamId: StreamTabIdSchema,
});
export type ResumeOdysseyMessage = z.infer<typeof ResumeOdysseyMessageSchema>;

export const AbandonOdysseyMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.ABANDON_ODYSSEY),
  streamId: StreamTabIdSchema,
  reason: z.string().nullish(),
});
export type AbandonOdysseyMessage = z.infer<typeof AbandonOdysseyMessageSchema>;

export const EditObjectiveMessageSchema = z.object({
  command: z.literal(ODYSSEY_VIEW_COMMANDS.EDIT_OBJECTIVE),
  streamId: StreamTabIdSchema,
  objective: z.string().min(1),
});
export type EditObjectiveMessage = z.infer<typeof EditObjectiveMessageSchema>;

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const OdysseyViewInboundMessageSchema = z.discriminatedUnion('command', [
  GetOdysseyStatusMessageSchema,
  GetOdysseyListMessageSchema,
  StartOdysseyMessageSchema,
  PauseOdysseyMessageSchema,
  ResumeOdysseyMessageSchema,
  AbandonOdysseyMessageSchema,
  EditObjectiveMessageSchema,
]);

export type OdysseyViewInboundMessage = z.infer<
  typeof OdysseyViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type OdysseyViewInboundHandlerRegistry =
  HandlerRegistry<OdysseyViewInboundMessage>;

export const dispatchOdysseyViewInbound = createDispatcher(
  OdysseyViewInboundMessageSchema,
);
