// `/config` and `texra config` — view and edit host-neutral settings.
//
// Unlike the single-Select pickers (`/approval`, `/login`), this is a list +
// drill-in: the outer list shows every catalog entry the CLI consumes with its
// current value and store; selecting a boolean toggles it inline, an enum opens
// an inner value picker, and a string/number opens an inline text editor.
// Reads/writes go through the host-aware `Settings` accessor so the same
// catalog drives the extension settings view and this panel without drift.

import {
  Secrets,
  Settings,
  type AppSignals,
} from '@texra-ai/worldline/plugins';
import { joinFacts } from '@texra-ai/worldline/schemas';
import { Effect, Result, Schema, SchemaAST } from 'effect';
import { useInput } from 'ink';
import { useState } from 'react';

import { apiKeyOrigins } from '@texra-ai/llm';
import { isCtrlInput } from '@cli/tui/inputKeys';
import { BACK_HINT } from '@cli/tui/ui/KeyHints';
import type { SelectItem } from '@cli/tui/ui/Select';
import { tuiUi } from '@cli/chat/tui/hosts/tuiUiHost';
import { commitProviderKey } from '@texra/controllers/settingsView/providerKeyActions';
import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  applyStateSettingUpdate,
  settingWriteFailure,
} from '@texra/controllers/settingsView/stateSettingWrite';
import {
  settingEnumChoices,
  settingEnumOptions,
} from '@texra/shared/settingsView/settingRows';
import type {
  SettingCategory,
  TexraSettingRow,
} from '@texra/shared/settings/settingSurfaces';
import type { ProcessServices } from '@texra-ai/worldline/host';

import {
  buildConfigCategoryItems,
  configCategoryLabel,
  isSettingCategory,
} from './configCategories';
import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { TextEntryForm } from './_shared/TextEntryForm';
import {
  runFormWrite,
  useAsyncListForm,
  useAsyncResource,
} from './_shared/useAsyncListForm';
import {
  formatProviderApiKeySummary,
  ProviderApiKeyForm,
} from './ProviderApiKeyForm';
import { SkillsSettingsForm } from './SkillsSettingsForm';
import { useChatProcess } from '../chatProcess';

const RESET_HINTS = [{ key: 'Ctrl-R', action: 'reset' }];

type SettingEditKind =
  | 'form'
  | 'boolean'
  | 'enum'
  | 'string'
  | 'number'
  | 'readonly';

type SettingInputResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * How a setting is edited in `/config`, derived from its schema: enums drill
 * into a value picker, booleans toggle inline, strings/numbers open a text
 * editor, form-backed settings delegate to an existing list form; anything
 * else (e.g. a record) is read-only.
 */
function settingEditKind(entry: TexraSettingRow): SettingEditKind {
  if (entry.openForm) return 'form';
  if (settingEnumOptions(entry)) return 'enum';
  // The schema's node is its value side, the row's default attached as its
  // stored form, so the node names what the value is. A nullable setting
  // (`NullOr`, a union with `Null`) edits as its value; Ctrl-R resets it to
  // null.
  const node = entry.schema.ast;
  const valueNode = SchemaAST.isUnion(node)
    ? node.types.find((member) => !SchemaAST.isNull(member))
    : node;
  switch (valueNode?._tag) {
    case 'Boolean':
      return 'boolean';
    case 'Number':
      return 'number';
    case 'String':
      return 'string';
    default:
      return 'readonly';
  }
}

/**
 * Coerce raw text-editor input to the value a `string`/`number` setting
 * expects. Invalid numeric input carries the user-facing error that keeps the
 * editor open instead of silently ignoring the submit.
 */
function coerceSettingInput(
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
    : { ok: false, message: 'Enter a valid number.' };
}

/** Coerce text input, then run the setting's own schema before writing. */
function validateSettingInput(
  entry: TexraSettingRow,
  raw: string,
  isNumber: boolean,
): SettingInputResult {
  const coerced = coerceSettingInput(raw, isNumber);
  if (!coerced.ok) return coerced;

  const parsed = Schema.decodeUnknownResult(entry.schema)(coerced.value);
  if (Result.isSuccess(parsed)) return { ok: true, value: parsed.success };

  return { ok: false, message: parsed.failure.message };
}

const SLOT_SCOPE_LABEL: Readonly<Record<TexraSettingRow['slot'], string>> = {
  config: 'config',
  workspaceState: 'project',
  repoState: 'repo',
  globalState: 'global',
};

/** A setting's current value as the list shows it: an enum value by its
 *  choice label, the label every settings UI shows. */
function formatSettingValue(entry: TexraSettingRow, value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (value === '' || value == null) return '(empty)';
  const choice = settingEnumChoices(entry)?.find((c) => c.value === value);
  return choice?.label ?? String(value);
}

function buildConfigListItems(
  entries: readonly TexraSettingRow[],
  readValue: (entry: TexraSettingRow) => unknown,
): Array<SelectItem<string>> {
  return entries.map((entry) => {
    const kind = settingEditKind(entry);
    const valueText =
      kind === 'form' ? 'open' : formatSettingValue(entry, readValue(entry));
    return {
      value: entry.key,
      label: entry.title,
      description: joinFacts([
        valueText,
        SLOT_SCOPE_LABEL[entry.slot],
        kind === 'readonly' && 'read-only',
      ]),
      disabled: kind === 'readonly',
    };
  });
}

function buildEnumItems(entry: TexraSettingRow): Array<SelectItem<string>> {
  return [...(settingEnumChoices(entry) ?? [])];
}

interface SettingsBrowserProps {
  readonly readValue: (entry: TexraSettingRow) => unknown;
  /** Write a setting, or reset it to its default with `null` (delete the
   *  key). This form owns the one run, so a rejected write rolls its
   *  optimistic value back on the same runner the surface holds. */
  readonly apply: (
    entry: TexraSettingRow,
    value: unknown,
  ) => Effect.Effect<void, Error, ProcessServices>;
  /** The API keys row's status line, and the form it opens. */
  readonly apiKeysSummary: string;
  readonly renderApiKeys: (onBack: () => void) => React.JSX.Element;
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

/** The value of the action row that leads the category list. */
const API_KEYS_ROW = 'api-keys';

type ConfigFormMode =
  | { readonly kind: 'categories' }
  | { readonly kind: 'api-keys' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'list'; readonly category: SettingCategory }
  | {
      readonly kind: 'enum';
      readonly entry: TexraSettingRow;
      readonly category: SettingCategory;
    }
  | {
      readonly kind: 'text';
      readonly entry: TexraSettingRow;
      readonly isNumber: boolean;
      readonly category: SettingCategory;
    };

function SettingsBrowser(props: SettingsBrowserProps): React.JSX.Element {
  const { chat } = useChatProcess();
  const [mode, setMode] = useState<ConfigFormMode>({ kind: 'categories' });
  // Optimistic overrides: a write is async, so without these a rapid second
  // toggle would recompute from a stale `readValue`. The override is set
  // synchronously (so the next keypress sees it), reconciles with the store
  // once the write lands, and rolls back if the write is rejected.
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});

  const effective = (entry: TexraSettingRow): unknown =>
    Object.hasOwn(overrides, entry.key)
      ? overrides[entry.key]
      : props.readValue(entry);

  // Optimistically show `optimisticValue`, run `action`, and roll the override
  // back to the prior value if it fails; the failure reaches the surface's
  // error hook.
  const runWrite = (
    entry: TexraSettingRow,
    optimisticValue: unknown,
    action: () => Effect.Effect<void, Error, ProcessServices>,
  ): void => {
    const previous = effective(entry);
    setOverrides((current) => ({ ...current, [entry.key]: optimisticValue }));
    runFormWrite(chat, action, {
      onError: (cause) => {
        setOverrides((current) => ({ ...current, [entry.key]: previous }));
        props.onError?.(cause);
      },
    });
  };

  const commit = (entry: TexraSettingRow, value: unknown): void =>
    runWrite(entry, value, () => props.apply(entry, value));

  // Clearing a text field resets the setting (deletes the key) so its default
  // reappears — otherwise a stored empty string can read back as "(empty)" while
  // a consumer that coalesces empty→default (e.g. the git-author reader) quietly
  // uses the default, leaving the panel and the effect out of sync.
  const resetEntry = (entry: TexraSettingRow): void => {
    runWrite(entry, TEXRA_SETTINGS.catalog.defaultOf(entry.key), () =>
      props.apply(entry, null),
    );
  };

  // Ctrl-R resets the setting open in the enum picker or the text editor.
  useInput((input, key) => {
    if (mode.kind !== 'enum' && mode.kind !== 'text') return;
    if (isCtrlInput(input, key, 'r')) {
      resetEntry(mode.entry);
      setMode({ kind: 'list', category: mode.category });
    }
  });

  const backToCategories = (): void => setMode({ kind: 'categories' });
  if (mode.kind === 'api-keys') return props.renderApiKeys(backToCategories);
  if (mode.kind === 'skills') {
    return (
      <SkillsSettingsForm
        availableRows={props.availableRows}
        onClose={backToCategories}
      />
    );
  }

  if (mode.kind === 'enum') {
    const { entry } = mode;
    const current = effective(entry);
    return (
      <ListForm
        title={joinFacts(['/config', entry.title])}
        availableRows={props.availableRows}
        items={buildEnumItems(entry)}
        activeValue={typeof current === 'string' ? current : undefined}
        action="select"
        extraHints={RESET_HINTS}
        escape={BACK_HINT}
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
        title={joinFacts(['/config', entry.title])}
        initialValue={current == null ? '' : String(current)}
        placeholder={isNumber ? 'Enter a number' : 'Enter a value'}
        masked={false}
        rawSubmit
        extraHints={RESET_HINTS}
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
      {
        value: API_KEYS_ROW,
        label: 'API keys',
        description: props.apiKeysSummary,
      },
      ...buildConfigCategoryItems(TEXRA_SETTINGS.cliRows),
    ];
    return (
      <ListForm
        title="/config"
        availableRows={props.availableRows}
        items={categories}
        emptyMessage="No configurable settings are available here yet."
        action="open"
        onSelect={(category) => {
          if (category === API_KEYS_ROW) {
            setMode({ kind: 'api-keys' });
            return;
          }
          if (isSettingCategory(category)) setMode({ kind: 'list', category });
        }}
        onCancel={props.onClose}
      />
    );
  }

  const { category } = mode;
  const categoryEntries = TEXRA_SETTINGS.cliRows.filter(
    (entry) => entry.category === category,
  );
  // `mode.category` always comes from `buildConfigCategoryItems`, so a
  // selected category always has at least one entry — no empty-list guard
  // needed here (the categories view above handles an empty catalog).
  const items = buildConfigListItems(categoryEntries, effective);

  const handleSelect = (key: string): void => {
    const entry = categoryEntries.find((candidate) => candidate.key === key);
    if (!entry) return;
    switch (settingEditKind(entry)) {
      case 'boolean':
        commit(entry, !effective(entry));
        return;
      case 'form':
        // The one list form a catalog row opens.
        if (entry.openForm === 'skills') setMode({ kind: 'skills' });
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
      title={joinFacts(['/config', configCategoryLabel(category)])}
      availableRows={props.availableRows}
      items={items}
      action="toggle / edit / open"
      escape={BACK_HINT}
      onSelect={handleSelect}
      onCancel={() => setMode({ kind: 'categories' })}
    />
  );
}

export interface CliConfigFormProps {
  readonly availableRows: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Canonical CLI configuration form. Both `texra config` and `/config` mount
 * it, so persistence and runtime side effects cannot diverge between them.
 */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  const apiKeys = useAsyncResource({
    load: () => Effect.flatMap(Secrets, apiKeyOrigins),
    onError: props.onError,
  });

  const settings = useAsyncListForm<Record<string, unknown>>({
    load: () =>
      Effect.map(
        Effect.forEach(TEXRA_SETTINGS.cliRows, (entry) =>
          Effect.map(
            Settings.get(roots, entry),
            (value) => [entry.key, value] as const,
          ),
        ),
        Object.fromEntries,
      ),
    onClose: props.onClose,
    onError: props.onError,
  });

  // The one CLI write path for a `/config` row: the same
  // `applyStateSettingUpdate` the extension and desktop settings views call.
  // The write announces what it changed to the process, which is how the
  // chat repaints its policy line. `null` is the shared reset convention
  // (delete the key so the schema default reappears).
  const applyUpdate = Effect.fn('applyUpdate')(function* (
    entry: TexraSettingRow,
    value: unknown,
  ): Effect.fn.Return<void, SettingsRequestFailed, AppSignals | Secrets> {
    const result = yield* applyStateSettingUpdate(entry, value, roots);
    // The browser rolls its optimistic value back on a failure and reports
    // it, so a refused write must fail rather than read as applied.
    const failure = settingWriteFailure(result);
    if (failure !== undefined) return yield* failure;
    if (result.kind === 'ignored') return;
    settings.reload();
  });

  const transient = renderAsyncListFormTransient({
    loading: settings.data === undefined && settings.loading,
    error: settings.error,
    title: '/config',
    loadingLabel: 'Loading settings…',
  });
  if (transient) return transient;

  return (
    <SettingsBrowser
      availableRows={props.availableRows}
      readValue={(entry) => settings.data?.[entry.key]}
      apply={applyUpdate}
      apiKeysSummary={formatProviderApiKeySummary(apiKeys)}
      renderApiKeys={(onBack) => (
        <ProviderApiKeyForm
          availableRows={props.availableRows}
          status={apiKeys}
          // The save and the refresh that follows it are one program.
          onSave={(provider, key) =>
            Effect.gen(function* () {
              yield* commitProviderKey(tuiUi, roots, provider, key);
              apiKeys.setData(
                (current) => current && { ...current, [provider]: 'secret' },
              );
              yield* apiKeys.refresh();
            })
          }
          onDone={onBack}
          onCancel={onBack}
        />
      )}
      onClose={props.onClose}
      onError={props.onError}
    />
  );
}
