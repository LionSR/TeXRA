/**
 * ChatGPT-subscription (Codex) model handler.
 *
 * A thin variant of the OpenAI Responses handler that authenticates with the
 * user's ChatGPT OAuth session instead of an API key and targets the
 * (unofficial) Codex backend. EXPERIMENTAL — see
 * docs/proposals/chatgpt-subscription-codex-auth.md.
 *
 * Only three things differ from the base Responses handler:
 *  1. credential — the OAuth access token is passed as the SDK `apiKey` (the
 *     SDK derives `Authorization: Bearer <token>` from it), refreshed per turn;
 *  2. endpoint + headers — `…/codex/responses`, plus `chatgpt-account-id`,
 *     `originator: texra` (our own, never `codex_cli_rs`), and the responses
 *     beta header;
 *  3. request shaping — the Codex backend rejects `max_output_tokens` and
 *     requires `store: false`, applied via a custom `fetch` so the large base
 *     request-builder is untouched. (System prompts already go to top-level
 *     `instructions`, which the backend wants.)
 */
import OpenAI from 'openai';

import {
  CODEX_ACCOUNT_ID_HEADER,
  CODEX_BACKEND_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_BETA_VALUE,
  CODEX_ORIGINATOR,
  CODEX_ORIGINATOR_HEADER,
  CodexAuthError,
  codexCoordinator,
} from '@auth/codex';

import { ModelHandlerOpenAIResponse } from './modelHandlerOpenAIResponse';

/** Flatten Responses message content (string or typed parts) to plain text. */
function partsToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True only for the generation endpoint (`…/responses`), not `…/responses/input_tokens`. */
function isGenerationRequest(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/responses');
  } catch {
    return url.endsWith('/responses');
  }
}

/**
 * The Codex backend is streaming-only, so a non-streaming caller's request is
 * sent with `stream: true` and the SSE is collapsed back into the single
 * Response JSON the SDK's non-streaming path expects. Returns the final
 * `response.completed` payload (falling back to the last response seen).
 */
function sseToResponseJson(sse: string): unknown | null {
  let completed: unknown = null;
  let last: unknown = null;
  for (const block of sse.split('\n\n')) {
    const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const payload = dataLine.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as {
        type?: string;
        response?: unknown;
      };
      if (event.response) {
        last = event.response;
        if (event.type === 'response.completed') completed = event.response;
      }
    } catch {
      // Ignore non-JSON keepalive lines.
    }
  }
  return completed ?? last;
}

/**
 * Rewrite the outgoing Responses request for the Codex backend:
 *  - drop `max_output_tokens` (rejected as unsupported) and `background`
 *    (the backend has no polling mode);
 *  - force `store: false`;
 *  - guarantee a non-empty top-level `instructions` (the backend returns
 *    `400 {"detail":"Instructions are required"}` otherwise), hoisting
 *    system/developer items out of `input` into `instructions` (matching
 *    Zed/Codex) with a minimal fallback;
 *  - force `stream: true` (the backend returns `400 Stream must be set to true`
 *    otherwise) and, for a non-streaming caller, collapse the SSE back to JSON.
 *
 * Token-counting / compaction endpoints are disabled at the capability level,
 * so only the generation endpoint reaches this rewrite.
 */
const codexFetch = (async (input, init) => {
  const url = requestUrl(input);
  if (
    !init ||
    init.method !== 'POST' ||
    typeof init.body !== 'string' ||
    !isGenerationRequest(url)
  ) {
    return fetch(input, init);
  }

  let callerWantsStream = true;
  try {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    delete body.max_output_tokens;
    delete body.background;
    body.store = false;

    const instructions: string[] = [];
    if (typeof body.instructions === 'string' && body.instructions.trim()) {
      instructions.push(body.instructions.trim());
    }
    if (Array.isArray(body.input)) {
      const kept: unknown[] = [];
      for (const item of body.input) {
        const role =
          item && typeof item === 'object'
            ? (item as { role?: unknown }).role
            : undefined;
        if (role === 'system' || role === 'developer') {
          const text = partsToText((item as { content?: unknown }).content);
          if (text.trim()) instructions.push(text.trim());
        } else {
          kept.push(item);
        }
      }
      body.input = kept;
    }
    body.instructions =
      instructions.join('\n\n') || 'You are a helpful assistant.';

    callerWantsStream = body.stream === true;
    body.stream = true;
    init = { ...init, body: JSON.stringify(body) };
  } catch {
    // Not JSON we can edit — send the original body unchanged.
  }

  const response = await fetch(input, init);
  if (callerWantsStream || !response.ok) return response;

  // Non-streaming caller: collapse the SSE into the single Response JSON.
  const sse = await response.text();
  const json = sseToResponseJson(sse);
  if (json == null) {
    return new Response(sse, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) satisfies typeof fetch;

export class ModelHandlerCodex extends ModelHandlerOpenAIResponse {
  // The Codex backend has no `/responses/input_tokens` or `/compact` endpoint
  // (they return 403); rely on the handler's heuristic fallbacks instead.
  public override get supportsTokenCounting(): boolean {
    return false;
  }

  public override get supportsManualCompaction(): boolean {
    return false;
  }

  /** OAuth access token in place of an API key (becomes the Bearer header). */
  public override async getApiKey(): Promise<string> {
    return this.resolveAccessToken();
  }

  /** Always the Codex backend (also disables the WebSocket transport path). */
  public override getBaseUrl(): string | null {
    return CODEX_BACKEND_BASE_URL;
  }

  protected override async createOpenAIClient(): Promise<OpenAI> {
    const apiKey = await this.resolveAccessToken();
    const accountId = await codexCoordinator().getAccountId();
    const defaultHeaders: Record<string, string> = {
      [CODEX_ORIGINATOR_HEADER]: CODEX_ORIGINATOR,
      [CODEX_BETA_HEADER]: CODEX_BETA_VALUE,
    };
    // Sent only when present; the backend tolerates its absence.
    if (accountId) defaultHeaders[CODEX_ACCOUNT_ID_HEADER] = accountId;

    this.logger.debug(
      `Using ChatGPT subscription (Codex). Base URL: ${CODEX_BACKEND_BASE_URL}`,
    );
    return new OpenAI({
      apiKey,
      baseURL: CODEX_BACKEND_BASE_URL,
      defaultHeaders,
      fetch: codexFetch,
    });
  }

  /** Fetch a fresh OAuth token, turning auth failures into actionable errors. */
  private async resolveAccessToken(): Promise<string> {
    try {
      return await codexCoordinator().getFreshAccessToken();
    } catch (error) {
      if (error instanceof CodexAuthError) {
        const action = error.needsReauth
          ? 'Sign in with ChatGPT again (Settings → Models), or turn off "Prefer ChatGPT subscription".'
          : 'Try again in a moment, or turn off "Prefer ChatGPT subscription".';
        throw new Error(
          `ChatGPT subscription unavailable: ${error.message} ${action}`,
        );
      }
      throw error;
    }
  }
}
