/**
 * Infrastructure logging facade — convenience wrapper over platform().log.
 *
 * Falls back to console before platform initialization to support
 * module-level `logger.initialize(CHANNEL)` calls at import time.
 *
 * NOTE: For agent-transcript logging (group context, structured events
 * visible in the webview), use `@logger/AgentLogger` instead.
 */
import { tryPlatform } from '@platform/platform';
import { consoleLog } from '@platform/defaults/consoleLog';
import type { LogBackend } from '@platform/interfaces/log';

function backend(): LogBackend {
  return tryPlatform()?.log ?? consoleLog;
}

export function initialize(channel: string, isAgent = false): void {
  backend().initialize(channel, isAgent);
}

export function debug(channel: string, message: string): void {
  backend().debug(channel, message);
}

export function info(channel: string, message: string): void {
  backend().info(channel, message);
}

export function warn(channel: string, message: string): void {
  backend().warn(channel, message);
}

export function error(channel: string, message: string): void {
  backend().error(channel, message);
}
