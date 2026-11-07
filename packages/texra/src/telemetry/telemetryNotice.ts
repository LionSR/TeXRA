import { Effect, Result, Schema } from 'effect';

import {
  AppState,
  Settings,
  type ConfigProvider,
} from '@texra-ai/harness/host';
import { toErrorMessage, type StateKey } from '@texra-ai/harness/schemas';
import { TELEMETRY_ENABLED_SETTING } from '@texra/shared/settingsView/texraSettings';

import { usageLoggingOptOut } from './UsageLogService';

/** Set once the first-run telemetry notice has been shown on this machine. */
const NOTICE_SHOWN_KEY = {
  key: 'telemetry.noticeShown',
  slot: 'globalState',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
} as const satisfies StateKey<boolean>;

/**
 * The first-run notice, or null. It is due once per machine while telemetry
 * is on: the flag is one global app-state row all three hosts share, marked
 * shown as it is returned so exactly one host prints it.
 * An opted-out user is not told about something that is not sent.
 */
export const telemetryNoticeIfDue = Effect.fn('telemetryNoticeIfDue')(
  function* (config: ConfigProvider) {
    if ((yield* usageLoggingOptOut(config)) !== null) return null;
    const state = yield* AppState;
    if (yield* Settings.state(state, NOTICE_SHOWN_KEY)) return null;
    yield* state.modify(NOTICE_SHOWN_KEY.key, () => Result.succeed(true));
    // The config line as the file stores it: the row's key under the
    // catalog's namespace.
    return `TeXRA sends anonymous usage metadata (agent, model, token counts, duration, host, version) with a random anonymous install ID. It never sends prompts, document content, file paths or error text. Turn it off with "${config.catalog.namespace}.${TELEMETRY_ENABLED_SETTING.key}": false, TEXRA_NO_TELEMETRY=1 or DO_NOT_TRACK=1. A custom agent is reported only as "custom". The "Usage logging" section of the configuration guide on texra.ai shows how to reset the ID.`;
  },
  // A store failure must not stop a host starting; say so and show nothing.
  Effect.catch((error) =>
    Effect.logWarning(
      `Could not record the telemetry notice: ${toErrorMessage(error)}`,
    ).pipe(Effect.as(null)),
  ),
);
