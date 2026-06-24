// `/config` — view and toggle host-neutral settings from the chat TUI.
//
// Unlike the single-Select pickers (`/approval`, `/api`), this is a list +
// drill-in: the outer list shows every catalog entry the CLI consumes with its
// current value and store; selecting a boolean toggles it inline, an enum opens
// an inner value picker, and free-text (string/number) entries render read-only
// for now (deferred editing). Reads/writes go through the host-aware
// `settingsAccess` accessor so the same catalog drives the extension settings
// view and this panel without drift.

import { Box, Text } from 'ink';
import { useState } from 'react';

import { stripPrefix } from '@shared/config/configKeys';
import {
  STATE_SETTINGS,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';

import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';
import { computeSelectWindowSize } from './_shared/selectWindow';

/** Catalog entries the CLI actually consumes — the `/config` roster. */
export const CLI_CONFIG_ROSTER: readonly StateSettingEntry[] =
  STATE_SETTINGS.filter((entry) => entry.hosts.includes('cli'));

export type SettingEditKind = 'boolean' | 'enum' | 'readonly';

/**
 * How a setting is edited in `/config`. Enum settings drill into a value
 * picker; booleans toggle inline; everything else (string/number) is read-only
 * for now (free-text editing is deferred).
 */
export function settingEditKind(
  entry: StateSettingEntry,
  value: unknown,
): SettingEditKind {
  if (entry.enumValues && entry.enumValues.length > 0) return 'enum';
  if (typeof value === 'boolean') return 'boolean';
  return 'readonly';
}

export function formatSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '' || value == null) return '(empty)';
  return String(value);
}

/** The store the CLI reads/writes this setting from (cliStore override wins). */
export function settingStoreLabel(entry: StateSettingEntry): string {
  return entry.cliStore ?? entry.store;
}

export function settingDisplayName(entry: StateSettingEntry): string {
  return stripPrefix(entry.key);
}

export function buildConfigListItems(
  entries: readonly StateSettingEntry[],
  readValue: (entry: StateSettingEntry) => unknown,
): Array<SelectItem<string>> {
  return entries.map((entry) => {
    const value = readValue(entry);
    const kind = settingEditKind(entry, value);
    const valueText = formatSettingValue(value);
    const store = settingStoreLabel(entry);
    const suffix = kind === 'readonly' ? ' · read-only' : '';
    return {
      value: entry.key,
      label: settingDisplayName(entry),
      description: `${valueText} · ${store}${suffix}`,
      disabled: kind === 'readonly',
    };
  });
}

export function buildEnumItems(
  entry: StateSettingEntry,
): Array<SelectItem<string>> {
  const values = entry.enumValues ?? [];
  const descriptions = entry.enumDescriptions ?? [];
  return values.map((value, index) => ({
    value,
    label: value,
    description: descriptions[index],
  }));
}

export interface ConfigFormProps {
  readonly entries: readonly StateSettingEntry[];
  readonly readValue: (entry: StateSettingEntry) => unknown;
  readonly writeValue: (
    entry: StateSettingEntry,
    value: unknown,
  ) => void | Promise<void>;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

type ConfigFormMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'enum'; readonly entry: StateSettingEntry };

const LIST_CHROME_ROWS = 5;
const ENUM_CHROME_ROWS = 4;

export function ConfigForm(props: ConfigFormProps): React.JSX.Element {
  const [mode, setMode] = useState<ConfigFormMode>({ kind: 'list' });
  // Values are read live from `props.readValue`; bumping this after a write
  // forces a re-render so the new value paints (the store itself is the SSOT).
  const [, setRevision] = useState(0);

  const commit = (entry: StateSettingEntry, value: unknown): void => {
    try {
      Promise.resolve(props.writeValue(entry, value))
        .then(() => setRevision((revision) => revision + 1))
        .catch((error: unknown) => props.onError?.(error));
    } catch (error: unknown) {
      props.onError?.(error);
    }
  };

  if (mode.kind === 'enum') {
    const { entry } = mode;
    const current = props.readValue(entry);
    const items = buildEnumItems(entry);
    const window = computeSelectWindowSize({
      availableRows: props.availableRows,
      itemCount: items.length,
      chromeRows: ENUM_CHROME_ROWS,
    });
    return (
      <FormFrame
        color="cyan"
        title={`/config · ${settingDisplayName(entry)}`}
        showCloseHint={false}
      >
        <Select
          items={items}
          activeValue={typeof current === 'string' ? current : undefined}
          maxVisibleItems={window.maxVisibleItems}
          showOverflow={window.showOverflow}
          onSelect={(value) => {
            commit(entry, value);
            setMode({ kind: 'list' });
          }}
          onCancel={() => setMode({ kind: 'list' })}
        />
        <Box marginTop={1}>
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'select' },
              { key: 'Esc', action: 'back' },
            ]}
            confirmCancel={false}
          />
        </Box>
      </FormFrame>
    );
  }

  const items = buildConfigListItems(props.entries, props.readValue);

  if (items.length === 0) {
    return (
      <FormFrame color="cyan" title="/config">
        <Text dimColor>No configurable settings are available here yet.</Text>
      </FormFrame>
    );
  }

  const window = computeSelectWindowSize({
    availableRows: props.availableRows,
    itemCount: items.length,
    chromeRows: LIST_CHROME_ROWS,
  });

  const handleSelect = (key: string): void => {
    const entry = props.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    const value = props.readValue(entry);
    const kind = settingEditKind(entry, value);
    if (kind === 'boolean') {
      commit(entry, !(value as boolean));
    } else if (kind === 'enum') {
      setMode({ kind: 'enum', entry });
    }
    // 'readonly' rows are disabled in the list and never reach here.
  };

  return (
    <FormFrame color="cyan" title="/config" showCloseHint={false}>
      <Select
        items={items}
        maxVisibleItems={window.maxVisibleItems}
        showOverflow={window.showOverflow}
        onSelect={handleSelect}
        onCancel={props.onClose}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'toggle / edit' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
