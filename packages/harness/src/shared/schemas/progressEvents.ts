import { Schema } from 'effect';

import { ProviderErrorClassificationSchema } from './errors';
import type { FileLocation } from './output';

/**
 * Shared output-file and host-presentation payloads. Session state is
 * defined by SessionEvent.
 */

/**
 * The instruction keys the harness itself emits as
 * {@link RequestShowInstructionPayload.key}. A key names the notice for the
 * host's "never remind again" state; an embedder decides what each of these
 * offers beside the message (TeXRA: the buttons that set a key or open a
 * guide). An embedder's own notices use keys of their own.
 */
export const HARNESS_INSTRUCTION_KEY = {
  MISSING_API_KEY: 'missingApiKey',
  MODEL_NOT_RECOGNIZED: 'modelNotRecognized',
  RESUME_REFUSED: 'resumeRefused',
} as const;

export type HarnessInstructionKey =
  (typeof HARNESS_INSTRUCTION_KEY)[keyof typeof HARNESS_INSTRUCTION_KEY];

/** Open a file for the person, beside what they are looking at, and build
 *  and show it if the host can. */
export interface OpenFilePayload {
  location: FileLocation;
  preserveFocus: boolean;
}

/** Show a suppressible instruction message. */
export interface RequestShowInstructionPayload {
  /** Names the notice: the host's suppression state, and what an embedder
   *  offers beside it ({@link HARNESS_INSTRUCTION_KEY} for the harness's). */
  key: string;
  message: string;
  showSuppress?: boolean;
}

/** The agent a launch named is not in the catalog. */
export interface AgentNotFoundPayload {
  agentName: string;
}

/**
 * The notice a refused launch carries for its caller to show
 * (`AgentError.notice`), as the presentation event and payload a host's
 * `emit` takes: the instruction for a model the build does not recognize,
 * or the agent the launch named that the catalog does not hold. The launch
 * shows nothing itself; the caller shows this where it shows the failure.
 */
export const LaunchNoticeSchema = Schema.Union([
  Schema.Struct({
    event: Schema.Literal('requestShowInstruction'),
    payload: Schema.Struct({
      key: Schema.String,
      message: Schema.String,
      showSuppress: Schema.optional(Schema.Boolean),
    }) satisfies Schema.Codec<RequestShowInstructionPayload, unknown>,
  }),
  Schema.Struct({
    event: Schema.Literal('agentNotFound'),
    payload: Schema.Struct({
      agentName: Schema.String,
    }) satisfies Schema.Codec<AgentNotFoundPayload, unknown>,
  }),
]);
/** A refused launch's notice ({@link LaunchNoticeSchema}). */
export type LaunchNotice = typeof LaunchNoticeSchema.Type;

/** Show an error message via a host notification. */
export const RequestShowErrorPayloadSchema = Schema.Struct({
  message: Schema.String,
  /** Docs page of the refusing request (e.g. 'file-management'); the host
   *  offers it as a guide link or action beside the message. */
  docsPage: Schema.optional(Schema.String),
  /** The classification of the failure `message` words: a host with words
   *  of its own for it shows them in place of `message`. */
  classification: Schema.optional(ProviderErrorClassificationSchema),
});
/** {@link RequestShowErrorPayloadSchema}'s value. */
export type RequestShowErrorPayload = typeof RequestShowErrorPayloadSchema.Type;
