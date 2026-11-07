/**
 * What the settings view does with each host message: decode it against the
 * outbound union once, then write it into the state in `settingsState.ts`.
 */
import { Result, Schema } from 'effect';

import { GlobalStateKey } from '@texra-ai/harness/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import {
  SettingsViewOutboundMessageSchema,
  type SettingsViewOutboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import {
  SETTINGS_PAGE_SECTIONS,
  SETTINGS_TAB_ORDER,
} from '@texra/shared/settingsView/settingsTarget';

import {
  applySettingsSnapshot,
  hostState,
  selectSettingsPage,
  settingSignal,
  settingsSnapshotRevisions,
} from './settingsState';

const decodeOutbound = Schema.decodeUnknownResult(
  SettingsViewOutboundMessageSchema,
);

function apply(message: SettingsViewOutboundMessage): void {
  switch (message.command) {
    case SETTINGS_VIEW_COMMANDS.SET_TAB: {
      // The schema admits only `page` or a `page/section` pair it declares.
      const { tab } = message;
      const page = SETTINGS_TAB_ORDER.find(
        (name) => tab === name || tab.startsWith(`${name}/`),
      );
      if (!page) throw new Error(`Unknown settings tab "${tab}"`);
      const section = SETTINGS_PAGE_SECTIONS[page].find(
        (name: string) => tab === `${page}/${name}`,
      );
      selectSettingsPage(page, section);
      return;
    }
    case SETTINGS_VIEW_COMMANDS.UPDATE_HOST_STATE: {
      const { patch } = message;
      hostState.set({ ...hostState.get(), ...patch });
      // The helper model is a catalog setting the Models page also sends.
      if (patch.models)
        settingSignal<string>(GlobalStateKey.HELPER_MODEL).set(
          patch.models.helperModel,
        );
      return;
    }
    case SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW: {
      const memory = hostState.get().memory;
      if (!memory) return;
      const { storagePath, preview, lineCount, error } = message.preview;
      const items = memory.items.map((item) => {
        if (item.storagePath !== storagePath) return item;
        if (error) {
          return {
            ...item,
            preview: undefined,
            lineCount: undefined,
            previewError: true,
          };
        }
        return {
          ...item,
          preview,
          lineCount: lineCount ?? item.lineCount,
          previewError: undefined,
        };
      });
      hostState.set({ ...hostState.get(), memory: { items } });
      return;
    }
    case SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT: {
      applySettingsSnapshot(message.values);
      const revisions = settingsSnapshotRevisions.get();
      settingsSnapshotRevisions.set({
        ...revisions,
        [message.snapshot]: (revisions[message.snapshot] ?? 0) + 1,
      });
      return;
    }
  }
}

/** Decode and apply one host message; a message that is not one of the
 *  settings view's is returned as the decode failure. */
export function applyOutboundMessage(raw: unknown): Result.Result<void, Error> {
  return Result.map(decodeOutbound(raw), apply);
}
