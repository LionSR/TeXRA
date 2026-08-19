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

import { isCtrlInput, type ReturnKeyInput } from '@cli/tui/inputKeys';
import { computeSelectWindowSize } from '@cli/tui/selectWindow';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { CROSS, POINTER } from '@cli/tui/ui/glyphs';
import {
  settingEnumOptions,
  settingIsBoolean,
  settingIsNumber,
  settingIsString,
  type SurfacedSettingEntry,
} from '@shared/schemas';
import { stripPrefix } from '@shared/config/configKeys';
import { settingDefault, settingSlot } from '@shared/config/settingsAccess';

import { BaseTextInput } from '../input/BaseTextInput';
import {
  buildConfigCategoryItems,
  configCategoryLabel,
} from './configCategories';
import { FormFrame } from './_shared/FormFrame';

export type SettingEditKind =
  'form' | 'boolean' | 'enum' | 'string' | 'number' | 'readonly';

export type SettingInputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * How a setting is edited in `/config`, derived from its schema: enums drill
 * into a value picker, booleans toggle inline, strings/numbers open a text
 * editor, form-backed settings delegate to an existing list form; anything
 * else (e.g. a record) is read-only.
 */
export function settingEditKind(entry: SurfacedSettingEntry): SettingEditKind {
  if (entry.openForm) return 'form';
  if (settingEnumOptions(entry)) return 'enum';
  if (settingIsBoolean(entry)) return 'boolean';
  if (settingIsNumber(entry)) return 'number';
  if (settingIsString(entry)) return 'string';
  return 'readonly';
}

/**
 * Coerce raw text-editor input to the value a `string`/`number` setting
 * expects. Invalid numeric input carries the user-facing error that keeps the
 * editor open instead of silently ignoring the submit.
 */
export function coerceSettingInput(
  raw: string,
  isNumber: boolean,
): SettingInputResult {
  if (!isNumber) return { ok: true, value: raw };
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, message: 'Enter a number, or press Ctrl-R to reset.' };
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, message: 'Enter a finite number.' };
}

/** Coerce text input, then run the setting's own schema before writing. */
export function validateSettingInput(
  entry: SurfacedSettingEntry,
  raw: string,
  isNumber: boolean,
): SettingInputResult {
  const coerced = coerceSettingInput(raw, isNumber);
  if (!coerced.ok) return coerced;

  const parsed = entry.schema.safeParse(coerced.value);
  if (parsed.success) return { ok: true, value: parsed.data };

  return {
    ok: false,
    message: parsed.error.issues.at(0)?.message ?? 'Invalid setting value.',
  };
}

export function isConfigResetInput(
  input: string,
  key: Pick<ReturnKeyInput, 'ctrl' | 'meta'>,
): boolean {
  return isCtrlInput(input, key, 'r');
}

export function formatSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '' || value == null) return '(empty)';
  return String(value);
}

/** The store the CLI reads/writes this setting from (`entry.slots.cli`). */
export function settingStoreLabel(entry: SurfacedSettingEntry): string {
  return settingSlot(entry, 'cli');
}

export function settingDisplayName(entry: SurfacedSettingEntry): string {
  return entry.title ?? stripPrefix(entry.key);
}

export function buildConfigListItems(
  entries: readonly SurfacedSettingEntry[],
  readValue: (entry: SurfacedSettingEntry) => unknown,
): Array<SelectItem<string>> {
  return entries.map((entry) => {
    const kind = settingEditKind(entry);
    const store = settingStoreLabel(entry);
    const valueText =
      kind === 'form'
        ? `open /${entry.openForm}`
        : formatSettingValue(readValue(entry));
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
  entry: SurfacedSettingEntry,
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
  readonly entries: readonly SurfacedSettingEntry[];
  readonly readValue: (entry: SurfacedSettingEntry) => unknown;
  readonly writeValue: (
    entry: SurfacedSettingEntry,
    value: unknown,
  ) => void | Promise<void>;
  /** Reset a setting to its default (delete the key). */
  readonly resetValue?: (entry: SurfacedSettingEntry) => void | Promise<void>;
  readonly openForm?: (formName: string) => void;
  readonly formLinks?: readonly {
    readonly name: string;
    readonly label: string;
    readonly description: string;
  }[];
  readonly formRenderers?: Readonly<
    Record<string, (onBack: () => void) => React.JSX.Element>
  >;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

type ConfigFormMode =
  | { readonly kind: 'categories' }
  | { readonly kind: 'linked-form'; readonly name: string }
  | { readonly kind: 'list'; readonly category: string }
  | {
      readonly kind: 'enum';
      readonly entry: SurfacedSettingEntry;
      readonly category: string;
    }
  | {
      readonly kind: 'text';
      readonly entry: SurfacedSettingEntry;
      readonly isNumber: boolean;
      readonly category: string;
    };

// Every /config layout wraps one Select in the same chrome: two FormFrame
// border rows, the title, the KeyHints margin, and the hints row.
const SELECT_CHROME_ROWS = 5;

/** Inline text editor for a string/number setting (its own input buffer). */
function ConfigTextEditor(props: {
  readonly entry: SurfacedSettingEntry;
  readonly initialValue: string;
  readonly isNumber: boolean;
  readonly onSubmit: (raw: string) => string | undefined;
  readonly onReset: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const [buffer, setBuffer] = useState(props.initialValue);
  const [error, setError] = useState<string>();
  // BaseTextInput owns Enter (onSubmit) and ignores Escape, so handle Escape
  // here to back out to the list.
  useInput((input, key) => {
    if (isConfigResetInput(input, key)) props.onReset();
    if (key.escape) props.onCancel();
  });
  return (
    <FormFrame
      title={`/config · ${settingDisplayName(props.entry)}`}
      showCloseHint={false}
    >
      <Box>
        <Text>{`${POINTER} `}</Text>
        <BaseTextInput
          value={buffer}
          placeholder={props.isNumber ? 'enter a number' : 'enter a value'}
          onChange={(value) => {
            setBuffer(value);
            if (error) setError(undefined);
          }}
          onSubmit={(raw) => {
            const submitError = props.onSubmit(raw);
            if (submitError) setError(submitError);
          }}
        />
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={COLOR_ERROR}>{`${CROSS} ${error}`}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', action: 'save' },
            { key: 'Ctrl-R', action: 'reset' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}

export function ConfigForm(props: ConfigFormProps): React.JSX.Element {
  const [mode, setMode] = useState<ConfigFormMode>({ kind: 'categories' });
  // Optimistic overrides: a write is async, so without these a rapid second
  // toggle would recompute from a stale `readValue`. The override is set
  // synchronously (so the next keypress sees it), reconciles with the store
  // once the write lands, and rolls back if the write is rejected.
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});

  const effective = (entry: SurfacedSettingEntry): unknown =>
    Object.hasOwn(overrides, entry.key)
      ? overrides[entry.key]
      : props.readValue(entry);

  // Optimistically show `optimisticValue`, run the async `action`, and roll the
  // override back to the prior value if it rejects. Starting from a resolved
  // promise routes both a synchronous throw (e.g. a schema-rejected value) and
  // an async rejection through the single `.catch`.
  const runWrite = (
    entry: SurfacedSettingEntry,
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

  const commit = (entry: SurfacedSettingEntry, value: unknown): void =>
    runWrite(entry, value, () => props.writeValue(entry, value));

  // Clearing a text field resets the setting (deletes the key) so its default
  // reappears — otherwise a stored empty string can read back as "(empty)" while
  // a consumer that coalesces empty→default (e.g. the git-author reader) quietly
  // uses the default, leaving the panel and the effect out of sync.
  const resetEntry = (entry: SurfacedSettingEntry): void => {
    if (!props.resetValue) {
      commit(entry, '');
      return;
    }
    runWrite(entry, settingDefault(entry), () => props.resetValue?.(entry));
  };

  useInput((input, key) => {
    if (mode.kind !== 'enum') return;
    if (isConfigResetInput(input, key)) {
      resetEntry(mode.entry);
      setMode({ kind: 'list', category: mode.category });
    }
  });

  // A form-backed setting renders inline when this host supplied a renderer;
  // otherwise the host opens the standalone form itself.
  const openNamedForm = (name: string): void => {
    if (props.formRenderers?.[name]) setMode({ kind: 'linked-form', name });
    else props.openForm?.(name);
  };

  if (mode.kind === 'linked-form') {
    return (
      props.formRenderers?.[mode.name]?.(() =>
        setMode({ kind: 'categories' }),
      ) ?? (
        <FormFrame title="/config">
          <Text dimColor>Configuration form unavailable.</Text>
        </FormFrame>
      )
    );
  }

  if (mode.kind === 'enum') {
    const { entry } = mode;
    const current = effective(entry);
    const items = buildEnumItems(entry);
    const window = computeSelectWindowSize({
      availableRows: props.availableRows,
      itemCount: items.length,
      chromeRows: SELECT_CHROME_ROWS,
    });
    return (
      <FormFrame
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
            setMode({ kind: 'list', category: mode.category });
          }}
          onCancel={() => setMode({ kind: 'list', category: mode.category })}
        />
        <Box marginTop={1}>
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'select' },
              { key: 'Ctrl-R', action: 'reset' },
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
            setMode({ kind: 'list', category: mode.category });
            return undefined;
          }

          const parsed = validateSettingInput(entry, raw, isNumber);
          if (!parsed.ok) return parsed.message;
          commit(entry, parsed.value);
          setMode({ kind: 'list', category: mode.category });
          return undefined;
        }}
        onReset={() => {
          resetEntry(entry);
          setMode({ kind: 'list', category: mode.category });
        }}
        onCancel={() => setMode({ kind: 'list', category: mode.category })}
      />
    );
  }

  if (mode.kind === 'categories') {
    const categories = [
      ...(props.formLinks ?? []).map((link) => ({
        value: `form:${link.name}`,
        label: link.label,
        description: link.description,
      })),
      ...buildConfigCategoryItems(props.entries),
    ];
    if (categories.length === 0) {
      return (
        <FormFrame title="/config">
          <Text dimColor>No configurable settings are available here yet.</Text>
        </FormFrame>
      );
    }
    const window = computeSelectWindowSize({
      availableRows: props.availableRows,
      itemCount: categories.length,
      chromeRows: SELECT_CHROME_ROWS,
    });
    return (
      <FormFrame title="/config" showCloseHint={false}>
        <Select
          items={categories}
          maxVisibleItems={window.maxVisibleItems}
          showOverflow={window.showOverflow}
          onSelect={(category) => {
            if (category.startsWith('form:')) {
              openNamedForm(category.slice('form:'.length));
              return;
            }
            setMode({ kind: 'list', category });
          }}
          onCancel={props.onClose}
        />
        <Box marginTop={1}>
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'open' },
              { key: 'Esc', action: 'close' },
            ]}
            confirmCancel={false}
          />
        </Box>
      </FormFrame>
    );
  }

  const { category } = mode;
  const categoryEntries = props.entries.filter(
    (entry) => entry.category === category,
  );
  // `mode.category` always comes from `buildConfigCategoryItems(props.entries)`,
  // so a selected category always has at least one entry — no empty-list guard
  // needed here (the categories view above handles empty `props.entries`).
  const items = buildConfigListItems(categoryEntries, effective);

  const window = computeSelectWindowSize({
    availableRows: props.availableRows,
    itemCount: items.length,
    chromeRows: SELECT_CHROME_ROWS,
  });

  const handleSelect = (key: string): void => {
    const entry = categoryEntries.find((candidate) => candidate.key === key);
    if (!entry) return;
    switch (settingEditKind(entry)) {
      case 'boolean':
        commit(entry, !(effective(entry) as boolean));
        return;
      case 'form':
        if (entry.openForm) openNamedForm(entry.openForm);
        return;
      case 'enum':
        setMode({ kind: 'enum', entry, category });
        return;
      case 'string':
        setMode({ kind: 'text', entry, isNumber: false, category });
        return;
      case 'number':
        setMode({ kind: 'text', entry, isNumber: true, category });
        return;
      case 'readonly':
        // Read-only rows are disabled in the list and never reach here.
        return;
    }
  };

  return (
    <FormFrame
      title={`/config · ${configCategoryLabel(category)}`}
      showCloseHint={false}
    >
      <Select
        items={items}
        maxVisibleItems={window.maxVisibleItems}
        showOverflow={window.showOverflow}
        onSelect={handleSelect}
        onCancel={() => setMode({ kind: 'categories' })}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'toggle / edit / open' },
            { key: 'Esc', action: 'back' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
