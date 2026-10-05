import { Effect, Result } from 'effect';

import { AppState, type ConfigProvider } from '@texra-ai/harness';
import { TELEMETRY_ENABLED_KEY } from '@shared/schemas';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';

import { toErrorMessage } from '@utils/errors/errorMessage';

import { usageLoggingOptOut } from './UsageLogService';

const TELEMETRY_NOTICE = `TeXRA sends anonymous usage metadata (agent, model, token counts, duration, host, version) with a random anonymous install ID. It never sends prompts, document content, file paths or error text. Turn it off with "${TELEMETRY_ENABLED_KEY}": false, TEXRA_NO_TELEMETRY=1 or DO_NOT_TRACK=1. A custom agent is reported only as "custom". The "Usage logging" section of the configuration guide on texra.ai shows how to reset the ID.`;

/**
 * The first-run notice, or null. It is due once per machine while telemetry
 * is on: the flag is one global app-state row all three hosts share, marked
 * shown as it is returned so exactly one host prints it.
 * An opted-out user is not told about something that is not sent.
 */
export const telemetryNoticeIfDue = Effect.fn('telemetryNoticeIfDue')(
  function* (config: ConfigProvider) {
    if (usageLoggingOptOut(config) !== null) return null;
    const state = yield* AppState;
    if ((yield* state.get(TexraStateKey.TELEMETRY_NOTICE_SHOWN)) === true)
      return null;
    yield* state.modify(TexraStateKey.TELEMETRY_NOTICE_SHOWN, () =>
      Result.succeed(true),
    );
    return TELEMETRY_NOTICE;
  },
  // A store failure must not stop a host starting; say so and show nothing.
  Effect.catch((error) =>
    Effect.logWarning(
      `Could not record the telemetry notice: ${toErrorMessage(error)}`,
    ).pipe(Effect.as(null)),
  ),
);
