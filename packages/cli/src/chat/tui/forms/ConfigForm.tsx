// `/config` — view and edit host-neutral settings from the chat TUI.
//
// Unlike the single-Select pickers (`/approval`, `/api`), this is a list +
// drill-in: the outer list shows every catalog entry the CLI consumes with its
// current value and store; selecting a boolean toggles it inline, an enum opens
// an inner value picker, and a string/number opens an inline text editor.
// Reads/writes go through the host-aware `settingsAccess` accessor so the same
// catalog drives the extension settings view and this panel without drift.

import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

import { stripPrefix } from '@shared/config/configKeys';
import { settingDefault, settingSlot } from '@shared/config/settingsAccess';
import {
  settingEnumOptions,
  settingIsBoolean,
  settingIsNumber,
  settingIsString,
  type StateSettingEntry,
} from '@shared/schemas/stateSettings';

import { BaseTextInput } from '../input/BaseTextInput';
import { KeyHints } from '../ui/KeyHints';
import { POINTER } from '../ui/glyphs';
import { Select, type SelectItem } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';
import { computeSelectWindowSize } from './_shared/selectWindow';

export type SettingEditKind =
  | 'boolean'
  | 'enum'
  | 'string'
  | 'number'
  | 'readonly';

/**
 * How a setting is edited in `/config`, derived from its schema: enums drill
 * into a value picker, booleans toggle inline, strings/numbers open a text
 * editor; anything else (e.g. a record) is read-only.
 */
export function settingEditKind(entry: StateSettingEntry): SettingEditKind {
  if (settingEnumOptions(entry)) return 'enum';
  if (settingIsBoolean(entry)) return 'boolean';
  if (settingIsNumber(entry)) return 'number';
  if (settingIsString(entry)) return 'string';
  return 'readonly';
}

/**
 * Coerce raw text-editor input to the value a `string`/`number` setting
 * expects, or `null` when a number field's input is blank or non-numeric (so
 * the caller can ignore the submit rather than write `NaN`). Range/format
 * violations are left to the schema, which rejects them on write.
 */
export function coerceSettingInput(
  raw: string,
  isNumber: boolean,
): { value: unknown } | null {
  if (!isNumber) return { value: raw };
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isNaN(parsed) ? null : { value: parsed };
}

export function formatSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '' || value == null) return '(empty)';
  return String(value);
}

/** The store the CLI reads/writes this setting from (cliStore override wins). */
export function settingStoreLabel(entry: StateSettingEntry): string {
  return settingSlot(entry, 'cli');
}

export function settingDisplayName(entry: StateSettingEntry): string {
  return stripPrefix(entry.key);
}

export function buildConfigListItems(
  entries: readonly StateSettingEntry[],
  readValue: (entry: StateSettingEntry) => unknown,
): Array<SelectItem<string>> {
  return entries.map((entry) => {
    const kind = settingEditKind(entry);
    const valueText = formatSettingValue(readValue(entry));
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
  const values = settingEnumOptions(entry) ?? [];
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
  /** Reset a setting to its default (delete the key). */
  readonly resetValue?: (entry: StateSettingEntry) => void | Promise<void>;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

type ConfigFormMode =
  | { readonly kind: 'list' }
  | { readonly kind: 'enum'; readonly entry: StateSettingEntry }
  | {
      readonly kind: 'text';
      readonly entry: StateSettingEntry;
      readonly isNumber: boolean;
    };

const LIST_CHROME_ROWS = 5;
const ENUM_CHROME_ROWS = 4;

/** Inline text editor for a string/number setting (its own input buffer). */
function ConfigTextEditor(props: {
  readonly entry: StateSettingEntry;
  readonly initialValue: string;
  readonly isNumber: boolean;
  readonly onSubmit: (raw: string) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [buffer, setBuffer] = useState(props.initialValue);
  // BaseTextInput owns Enter (onSubmit) and ignores Escape, so handle Escape
  // here to back out to the list.
  useInput((_input, key) => {
    if (key.escape) props.onCancel();
  });
  return (
    <FormFrame
      color="cyan"
      title={`/config · ${settingDisplayName(props.entry)}`}
      showCloseHint={false}
    >
      <Box>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={buffer}
          placeholder={props.isNumber ? 'enter a number' : 'enter a value'}
          onChange={setBuffer}
          onSubmit={props.onSubmit}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', action: 'save' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}

export function ConfigForm(props: ConfigFormProps): React.JSX.Element {
  const [mode, setMode] = useState<ConfigFormMode>({ kind: 'list' });
  // Optimistic overrides: a write is async, so without these a rapid second
  // toggle would recompute from a stale `readValue`. The override is set
  // synchronously (so the next keypress sees it), reconciles with the store
  // once the write lands, and rolls back if the write is rejected.
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});

  const effective = (entry: StateSettingEntry): unknown =>
    Object.hasOwn(overrides, entry.key)
      ? overrides[entry.key]
      : props.readValue(entry);

  // Optimistically show `optimisticValue`, run the async `action`, and roll the
  // override back to the prior value if it rejects. Starting from a resolved
  // promise routes both a synchronous throw (e.g. a schema-rejected value) and
  // an async rejection through the single `.catch`.
  const runWrite = (
    entry: StateSettingEntry,
    optimisticValue: unknown,
    action: () => void | Promise<void>,
  ): void => {
    const previous = effective(entry);
    setOverrides((current) => ({ ...current, [entry.key]: optimisticValue }));
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        setOverrides((current) => ({ ...current, [entry.key]: previous }));
        props.onError?.(error);
      });
  };

  const commit = (entry: StateSettingEntry, value: unknown): void =>
    runWrite(entry, value, () => props.writeValue(entry, value));

  // Clearing a text field resets the setting (deletes the key) so its default
  // reappears — otherwise a stored empty string can read back as "(empty)" while
  // a consumer that coalesces empty→default (e.g. the git-author reader) quietly
  // uses the default, leaving the panel and the effect out of sync.
  const resetEntry = (entry: StateSettingEntry): void => {
    if (!props.resetValue) {
      commit(entry, '');
      return;
    }
    runWrite(entry, settingDefault(entry), () => props.resetValue?.(entry));
  };

  if (mode.kind === 'enum') {
    const { entry } = mode;
    const current = effective(entry);
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

  if (mode.kind === 'text') {
    const { entry, isNumber } = mode;
    const current = effective(entry);
    return (
      <ConfigTextEditor
        key={entry.key}
        entry={entry}
        initialValue={current == null ? '' : String(current)}
        isNumber={isNumber}
        onSubmit={(raw) => {
          if (!isNumber && raw.trim() === '') {
            resetEntry(entry);
          } else {
            const coerced = coerceSettingInput(raw, isNumber);
            if (coerced) commit(entry, coerced.value);
          }
          setMode({ kind: 'list' });
        }}
        onCancel={() => setMode({ kind: 'list' })}
      />
    );
  }

  const items = buildConfigListItems(props.entries, effective);

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
    const kind = settingEditKind(entry);
    if (kind === 'boolean') {
      commit(entry, !(effective(entry) as boolean));
    } else if (kind === 'enum') {
      setMode({ kind: 'enum', entry });
    } else if (kind === 'string') {
      setMode({ kind: 'text', entry, isNumber: false });
    } else if (kind === 'number') {
      setMode({ kind: 'text', entry, isNumber: true });
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
