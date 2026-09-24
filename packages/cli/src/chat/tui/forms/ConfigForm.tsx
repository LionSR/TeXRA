// `/config` — view and edit host-neutral settings from the chat TUI.
//
// Unlike the single-Select pickers (`/approval`, `/login`), this is a list +
// drill-in: the outer list shows every catalog entry the CLI consumes with its
// current value and store; selecting a boolean toggles it inline, an enum opens
// an inner value picker, and a string/number opens an inline text editor.
// Reads/writes go through the host-aware `settingsAccess` accessor so the same
// catalog drives the extension settings view and this panel without drift.

import { Text, useInput } from 'ink';
import { useState } from 'react';

import { isCtrlInput, type ReturnKeyInput } from '@cli/tui/inputKeys';
import type { SelectItem } from '@cli/tui/ui/Select';
import type { ProcessRuntime } from '@platform/processRuntime';
import {
  settingEnumOptions,
  settingIsBoolean,
  settingIsNumber,
  settingIsString,
  type SurfacedSettingEntry,
} from '@shared/state/stateSettings';
import { stripPrefix } from '@shared/config/configKeys';
import { settingDefault, settingSlot } from '@shared/config/settingsAccess';

import {
  buildConfigCategoryItems,
  configCategoryLabel,
} from './configCategories';
import { FormFrame } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { TextEntryForm } from './_shared/TextEntryForm';
import { runFormWrite } from './_shared/useAsyncListForm';
import type { Effect } from 'effect';

type SettingEditKind =
  'form' | 'boolean' | 'enum' | 'string' | 'number' | 'readonly';

type SettingInputResult =
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

function formatSettingValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '' || value == null) return '(empty)';
  return String(value);
}

/** The store the CLI reads/writes this setting from (`entry.slots.cli`). */
function settingStoreLabel(entry: SurfacedSettingEntry): string {
  return settingSlot(entry, 'cli');
}

function settingDisplayName(entry: SurfacedSettingEntry): string {
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
      kind === 'form' ? 'open' : formatSettingValue(readValue(entry));
    const suffix = kind === 'readonly' ? ' · read-only' : '';
    return {
      value: entry.key,
      label: settingDisplayName(entry),
      description: `${valueText} · ${store}${suffix}`,
      disabled: kind === 'readonly',
    };
  });
}

function buildEnumItems(
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

interface ConfigFormProps {
  readonly entries: readonly SurfacedSettingEntry[];
  readonly readValue: (entry: SurfacedSettingEntry) => unknown;
  /** The write as a program: this form owns the one run, so a rejected write
   *  rolls its optimistic value back on the same runtime the surface holds. */
  readonly writeValue: (
    entry: SurfacedSettingEntry,
    value: unknown,
  ) => Effect.Effect<void, Error>;
  /** Reset a setting to its default (delete the key). */
  readonly resetValue: (
    entry: SurfacedSettingEntry,
  ) => Effect.Effect<void, Error>;
  /** The runtime the writes above settle on, from the surface that mounted
   *  this form — Ink components run no Effect of their own. */
  readonly runtime: ProcessRuntime;
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

  // Optimistically show `optimisticValue`, run `action`, and roll the override
  // back to the prior value if it fails; the failure reaches the surface's
  // error hook.
  const runWrite = (
    entry: SurfacedSettingEntry,
    optimisticValue: unknown,
    action: () => Effect.Effect<void, Error>,
  ): void => {
    const previous = effective(entry);
    setOverrides((current) => ({ ...current, [entry.key]: optimisticValue }));
    runFormWrite(props.runtime, action, {
      onError: (cause) => {
        setOverrides((current) => ({ ...current, [entry.key]: previous }));
        props.onError?.(cause);
      },
    });
  };

  const commit = (entry: SurfacedSettingEntry, value: unknown): void =>
    runWrite(entry, value, () => props.writeValue(entry, value));

  // Clearing a text field resets the setting (deletes the key) so its default
  // reappears — otherwise a stored empty string can read back as "(empty)" while
  // a consumer that coalesces empty→default (e.g. the git-author reader) quietly
  // uses the default, leaving the panel and the effect out of sync.
  const resetEntry = (entry: SurfacedSettingEntry): void => {
    runWrite(entry, settingDefault(entry), () => props.resetValue(entry));
  };

  useInput((input, key) => {
    if (mode.kind !== 'enum') return;
    if (isConfigResetInput(input, key)) {
      resetEntry(mode.entry);
      setMode({ kind: 'list', category: mode.category });
    }
  });

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
    return (
      <ListForm
        title={`/config · ${settingDisplayName(entry)}`}
        availableRows={props.availableRows}
        items={buildEnumItems(entry)}
        activeValue={typeof current === 'string' ? current : undefined}
        action="select"
        extraHints={[{ key: 'Ctrl-R', action: 'reset' }]}
        escapeAction="back"
        onSelect={(value) => {
          commit(entry, value);
          setMode({ kind: 'list', category: mode.category });
        }}
        onCancel={() => setMode({ kind: 'list', category: mode.category })}
      />
    );
  }

  if (mode.kind === 'text') {
    const { entry, isNumber } = mode;
    const current = effective(entry);
    return (
      <TextEntryForm
        key={entry.key}
        title={`/config · ${settingDisplayName(entry)}`}
        initialValue={current == null ? '' : String(current)}
        placeholder={isNumber ? 'enter a number' : 'enter a value'}
        masked={false}
        rawSubmit
        extraHints={[{ key: 'Ctrl-R', action: 'reset' }]}
        onKey={(input, key) => {
          if (isConfigResetInput(input, key)) {
            resetEntry(entry);
            setMode({ kind: 'list', category: mode.category });
          }
        }}
        onSubmit={(raw) => {
          if (!isNumber && raw.trim() === '') {
            resetEntry(entry);
            setMode({ kind: 'list', category: mode.category });
            return;
          }

          const parsed = validateSettingInput(entry, raw, isNumber);
          if (!parsed.ok) return parsed.message;
          commit(entry, parsed.value);
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
    return (
      <ListForm
        title="/config"
        availableRows={props.availableRows}
        items={categories}
        emptyMessage="No configurable settings are available here yet."
        action="open"
        onSelect={(category) => {
          if (category.startsWith('form:')) {
            setMode({
              kind: 'linked-form',
              name: category.slice('form:'.length),
            });
            return;
          }
          setMode({ kind: 'list', category });
        }}
        onCancel={props.onClose}
      />
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

  const handleSelect = (key: string): void => {
    const entry = categoryEntries.find((candidate) => candidate.key === key);
    if (!entry) return;
    switch (settingEditKind(entry)) {
      case 'boolean':
        commit(entry, !(effective(entry) as boolean));
        return;
      case 'form':
        if (entry.openForm)
          setMode({ kind: 'linked-form', name: entry.openForm });
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
    <ListForm
      title={`/config · ${configCategoryLabel(category)}`}
      availableRows={props.availableRows}
      items={items}
      action="toggle / edit / open"
      escapeAction="back"
      onSelect={handleSelect}
      onCancel={() => setMode({ kind: 'categories' })}
    />
  );
}
