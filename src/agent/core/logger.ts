/**
 * Logging facade — convenience wrapper over platform().log.
 *
 * Falls back to console before platform initialization to support
 * module-level `logger.initialize(CHANNEL)` calls at import time.
 *
 * NOTE: Group-context functions (getActiveGroupId, runWithGroupContext)
 * are intentionally NOT exposed here — used only by AgentLogger via
 * @logger/logUtils directly.
 */
import { tryPlatform } from '@platform/platform';
import { consoleLog } from '@platform/defaults/consoleLog';
import type { LogBackend, LogUtilsOptions } from '@platform/interfaces/log';

function backend(): LogBackend {
  return tryPlatform()?.log ?? consoleLog;
}

export function initialize(channel: string, isAgent = false): void {
  backend().initialize(channel, isAgent);
}

export function debug(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().debug(channel, message, options);
}

export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().info(channel, message, options);
}

export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().warn(channel, message, options);
}

export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  backend().error(channel, message, options);
}
