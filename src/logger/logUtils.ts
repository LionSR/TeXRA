// Third-party imports
import { randomUUID } from 'crypto';

// Local imports - logger
import { registry } from './LogChannelRegistry';
import type { MessageType } from './messageTypes';
import type { VSCodeTransport } from './transports/VSCodeTransport';

function getTransport(channel: string): VSCodeTransport | undefined {
  return registry.getTransport(channel);
}

function getOrCreateTransport(
  channel: string,
  isAgent: boolean,
): VSCodeTransport {
  registry.ensure(channel, { isAgent });
  const transport = getTransport(channel);
  if (!transport) {
    throw new Error(`Failed to initialise logger transport for channel ${channel}`);
  }
  return transport;
}

function logWithGroup(
  channel: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  const logger = registry.getLogger(channel, { isAgent });
  const transport = getTransport(channel);
  const activeGroupId = groupId ?? transport?.getActiveGroupId();

  // @ts-expect-error - winston logger exposes dynamic level helpers
  logger[level](message, { groupId: activeGroupId, messageType, data });
}

export function initialize(channel: string, isAgent = false): void {
  registry.ensure(channel, { isAgent });
}

export function startGroup(
  channel: string,
  groupName: string,
  id?: string,
  parentGroupId?: string,
  isAgent = false,
): string {
  const transport = getOrCreateTransport(channel, isAgent);
  const groupId = id ?? randomUUID();
  return transport.startGroup(groupName, groupId, parentGroupId);
}

export function endGroup(
  channel: string,
  groupId: string,
  status: 'error' | 'stopped' = 'stopped',
): void {
  const transport = getTransport(channel);
  transport?.endGroup(groupId, status);
}

export function getActiveGroupId(channel: string): string | undefined {
  const transport = getTransport(channel);
  return transport?.getActiveGroupId();
}

export function setActiveGroupId(
  channel: string,
  groupId: string | undefined,
): void {
  const transport = getTransport(channel);
  transport?.setActiveGroupId(groupId);
}

export function debug(
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  logWithGroup(channel, 'debug', message, groupId, messageType, isAgent, data);
}

export function info(
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  logWithGroup(channel, 'info', message, groupId, messageType, isAgent, data);
}

export function warn(
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  logWithGroup(channel, 'warn', message, groupId, messageType, isAgent, data);
}

export function error(
  channel: string,
  message: string,
  groupId?: string,
  messageType?: MessageType,
  isAgent = false,
  data?: unknown,
): void {
  logWithGroup(channel, 'error', message, groupId, messageType, isAgent, data);
}

export function getTimestamp(): string {
  return new Date()
    .toLocaleString('en-US', {
      year: '2-digit',
      month: '2-digit',
      day: '2-digit',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    .replace(',', '');
}

