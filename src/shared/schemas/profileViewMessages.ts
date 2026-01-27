/**
 * Schema definitions for ProfileView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_PROFILE)
 * Inbound: Frontend → Backend (GET_PROFILE_DATA, SELECT_AGENT, etc.)
 */
import { z } from 'zod';

import { PROFILE_VIEW_COMMANDS } from '@common/webview/commands';

// ============================================================
// Data schemas
// ============================================================

export const ProfileUserSchema = z.object({
  email: z.string(),
  id: z.string(),
});
export type ProfileUser = z.infer<typeof ProfileUserSchema>;

export const RemoteAgentSchema = z.object({
  name: z.string(),
  description: z.string(),
  visibility: z.array(z.string()),
  category: z.string(),
  supportsMultipleOutput: z.boolean(),
});
export type RemoteAgent = z.infer<typeof RemoteAgentSchema>;

export const ApiAccessModeSchema = z.enum(['included', 'personal']);
export type ApiAccessMode = z.infer<typeof ApiAccessModeSchema>;

export const TierConstantsSchema = z.object({
  ultra: z.string(),
  max: z.string(),
});
export type TierConstants = z.infer<typeof TierConstantsSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateProfileMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.UPDATE_PROFILE),
  authenticated: z.boolean(),
  user: ProfileUserSchema.nullable(),
  tier: z.string(),
  permissions: z.array(z.string()),
  remoteAgents: z.array(RemoteAgentSchema),
  apiAccessMode: ApiAccessModeSchema,
  enabledProviders: z.array(z.string()),
  allowedModels: z.array(z.string()).nullable(),
  tierConstants: TierConstantsSchema,
  accessExpiresAt: z.string().nullish(),
});
export type UpdateProfileMessage = z.infer<typeof UpdateProfileMessageSchema>;

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Agent selection message (reusable field schema) */
export const SelectAgentMessageSchema = z.object({
  agentName: z.string().min(1),
});
export type SelectAgentMessage = z.infer<typeof SelectAgentMessageSchema>;

/** API access mode message (reusable field schema) */
export const SetApiAccessModeMessageSchema = z.object({
  mode: ApiAccessModeSchema,
});
export type SetApiAccessModeMessage = z.infer<
  typeof SetApiAccessModeMessageSchema
>;

// Inbound messages with command literals
const GetProfileDataMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.GET_PROFILE_DATA),
});

const SelectAgentInboundMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.SELECT_AGENT),
  agentName: z.string().min(1),
});

const SignInMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.SIGN_IN),
});

const SignOutMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.SIGN_OUT),
});

const SetApiAccessModeInboundMessageSchema = z.object({
  command: z.literal(PROFILE_VIEW_COMMANDS.SET_API_ACCESS_MODE),
  mode: ApiAccessModeSchema,
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const ProfileViewInboundMessageSchema = z.discriminatedUnion('command', [
  GetProfileDataMessageSchema,
  SelectAgentInboundMessageSchema,
  SignInMessageSchema,
  SignOutMessageSchema,
  SetApiAccessModeInboundMessageSchema,
]);

export type ProfileViewInboundMessage = z.infer<
  typeof ProfileViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry
// ============================================================

type TypedInboundHandler<T extends ProfileViewInboundMessage> = (
  data: T,
) => Promise<void> | void;

export type ProfileViewInboundHandlerRegistry = {
  [K in ProfileViewInboundMessage['command']]?: TypedInboundHandler<
    Extract<ProfileViewInboundMessage, { command: K }>
  >;
};

// ============================================================
// Dispatcher function
// ============================================================

export function dispatchProfileViewInbound(
  raw: unknown,
  handlers: ProfileViewInboundHandlerRegistry,
  onError?: (error: unknown) => void,
): boolean {
  const result = ProfileViewInboundMessageSchema.safeParse(raw);
  if (!result.success) {
    onError?.(result.error);
    return false;
  }

  const message = result.data;
  const handler = handlers[message.command] as
    | TypedInboundHandler<typeof message>
    | undefined;

  if (handler) {
    const maybePromise = handler(message);
    if (maybePromise instanceof Promise) {
      maybePromise.catch((error) => onError?.(error));
    }
    return true;
  }

  return false;
}
