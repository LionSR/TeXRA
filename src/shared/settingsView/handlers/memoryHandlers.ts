/**
 * Memory tab shared helpers.
 *
 * The heavy lifting already lives in `SettingsMemoryController`; both hosts
 * follow the same try/post-result pattern around its methods. This module
 * centralises that pattern so each host only has to wire its respond hook.
 */
import type { SettingsMemoryController } from '@controllers/settingsView/SettingsMemoryController';

import type { SettingsRespond } from './types';

export async function postMemoryData(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
): Promise<void> {
  respond(await controller.getMemoryDataMessage());
}

export async function postMemoryPreview(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
  storagePath: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    respond(await controller.getMemoryPreviewMessage(storagePath));
  } catch (error) {
    onError(error);
    respond(controller.getMemoryPreviewErrorMessage(storagePath));
  }
}

export function postMemoryEnabled(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
): void {
  respond(controller.getMemoryEnabledMessage());
}

export async function setMemoryPinned(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
  storagePath: string,
  pinned: boolean,
): Promise<void> {
  const message = pinned
    ? await controller.pinMemory(storagePath)
    : await controller.unpinMemory(storagePath);
  if (message) respond(message);
}

export async function deleteMemory(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
  input: { storagePath: string; displayPath: string },
): Promise<void> {
  const message = await controller.deleteMemory(input);
  if (message) respond(message);
}

export async function setMemoryEnabled(
  controller: SettingsMemoryController,
  respond: SettingsRespond,
  enabled: boolean,
): Promise<void> {
  const message = await controller.setMemoryEnabled(enabled);
  if (message) respond(message);
}
