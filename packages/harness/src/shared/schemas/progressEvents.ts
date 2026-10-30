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

/** Show an error message via a host notification. */
export interface RequestShowErrorPayload {
  message: string;
  /** Docs page of the refusing request (e.g. 'file-management'); the host
   *  offers it as a guide link or action beside the message. */
  docsPage?: string;
}
