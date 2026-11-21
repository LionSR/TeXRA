import { Effect, Schema } from 'effect';
import {
  decodingDefault,
  toErrorMessage,
  type StateKey,
} from '@texra-ai/harness/schemas';

import {
  Settings,
  AppState,
  type ConfigProvider,
} from '@texra-ai/harness/plugins';
import {
  TELEMETRY_ENABLED_SETTING,
  USAGE_LOGGING_SENDS,
} from '@texra/shared/settings/texraSettings';

import {
  HostTelemetrySwitch,
  USAGE_LOGGING_ENV_OPT_OUT,
  usageLoggingOptOut,
} from './UsageLogService';

/** Set once the first-run telemetry notice has been shown on this machine. */
const NOTICE_SHOWN_KEY = {
  key: 'telemetry.noticeShown',
  slot: 'globalState',
  schema: decodingDefault(Schema.Boolean, false),
} as const satisfies StateKey<boolean>;

/**
 * The first-run notice, or null. It is due once per machine while telemetry
 * is on: the flag is one global app-state row all three hosts share, marked
 * shown as it is returned so exactly one host prints it.
 * An opted-out user, or one whose host switch is off, is not told about
 * something that is not sent.
 */
export const telemetryNoticeIfDue = Effect.fn('telemetryNoticeIfDue')(
  function* (config: ConfigProvider) {
    if (!(yield* HostTelemetrySwitch)()) return null;
    if ((yield* usageLoggingOptOut(config)) !== null) return null;
    const state = yield* AppState;
    if (yield* Settings.state(state, NOTICE_SHOWN_KEY)) return null;
    yield* state.update(NOTICE_SHOWN_KEY.key, true);
    // The config line as the file stores it: the row's key under the
    // catalog's namespace.
    return `${USAGE_LOGGING_SENDS} Turn it off with "${config.catalog.namespace}.${TELEMETRY_ENABLED_SETTING.key}": false, ${USAGE_LOGGING_ENV_OPT_OUT}. A custom agent is reported only as "custom". The "Usage logging" section of the configuration guide on texra.ai shows how to reset the ID.`;
  },
  // A store failure must not stop a host starting; say so and show nothing.
  Effect.catch((error) =>
    Effect.logWarning(
      `Could not record the telemetry notice: ${toErrorMessage(error)}`,
    ).pipe(Effect.as(null)),
  ),
);
