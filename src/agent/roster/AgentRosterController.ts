import type { StateStore } from '@platform/interfaces';
import {
  agentMatchesIdentifier,
  agentKeyOf,
  agentName,
  byCategory,
  AGENT_CATEGORIES,
  type AgentCategory,
  type AgentSource,
  type ByCategory,
} from '@shared/schemas/agent';
import {
  AgentDelegationScopeLegacySchema,
  AgentRosterSelectionSchema,
  INHERITED_AGENT_ROSTER,
  type AgentRosterCategorySelection,
  type AgentRosterSelection,
} from '@shared/schemas/agentRoster';
import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';
import {
  getDefaultTeamId,
  setDefaultTeamId,
} from '@shared/state/onboardingState';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { KeyedMutex, unique } from '@utils/core';

export interface AgentRosterEntry {
  readonly name: string;
  readonly source: AgentSource;
  readonly category: AgentCategory;
}

export class InvalidAgentTeamError extends Error {}

export interface AgentRosterControllerDeps<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: (category: AgentCategory) => Entry[];
  readonly getPresets?: () => readonly AgentModePreset[];
  /** Resolve one stored identifier without collapsing exact source identity. */
  readonly resolveAgent?: (
    category: AgentCategory,
    identifier: string,
  ) => Entry | undefined;
  /** Host policy used only when an inherited roster has no user default. */
  readonly fallbackTeamId?: string | null;
}

const workspaceWriteMutex = new KeyedMutex<StateStore>();

function serializeWorkspaceWrite(
  store: StateStore,
  write: () => Promise<void>,
): Promise<void> {
  return workspaceWriteMutex.runExclusive(store, write);
}

export interface AgentRosterSnapshot<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  readonly selection: AgentRosterSelection;
  readonly effectiveSelection: Exclude<
    AgentRosterSelection,
    { readonly kind: 'inherit' }
  >;
  readonly defaultTeamId?: string;
  /** Persisted team identity that could not be resolved; effective roster is all. */
  readonly missingTeamId?: string;
  readonly agents: ByCategory<Entry[]>;
  readonly unresolvedNames: string[];
}

function allPresets(
  extra: readonly AgentModePreset[] = [],
): readonly AgentModePreset[] {
  return [STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS, ...extra];
}

/**
 * Read the canonical workspace selection. A value that does not parse is
 * tried against the legacy pair-shaped format (`{workflowAgentKeys,
 * toolUseAgentKeys}`, with or without a stray `kind` field) via the existing
 * AgentDelegationScopeLegacySchema. On a match the stored value is
 * immediately repaired so the warning is a one-time event per workspace.
 */
function readAgentRosterSelection(
  workspaceState: StateStore,
): AgentRosterSelection {
  const raw = workspaceState.get<unknown>(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
  );
  if (raw === undefined) return INHERITED_AGENT_ROSTER;
  const parsed = AgentRosterSelectionSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const repaired = repairLegacySelection(raw);
  if (repaired) {
    void workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      repaired,
    );
    return repaired;
  }
  console.warn(
    `[agentRoster] Ignoring malformed roster selection; falling back to ` +
      `the inherited roster: ${parsed.error.message}`,
  );
  return INHERITED_AGENT_ROSTER;
}

function repairLegacySelection(raw: unknown): AgentRosterSelection | undefined {
  // The legacy pair-shaped value may carry a stray `kind` field: an
  // intermediate version wrote `{kind: 'custom', workflowAgentKeys,
  // toolUseAgentKeys}` under AGENT_ROSTER_SELECTION, which neither the
  // canonical schema (missing `agentKeys`) nor the strict legacy schema
  // (rejects `kind`) accepts. Drop the discriminant before parsing so both
  // the pure and hybrid legacy shapes repair to the same canonical value.
  const candidate =
    raw !== null && typeof raw === 'object' && 'kind' in raw
      ? Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter(
            ([key]) => key !== 'kind',
          ),
        )
      : raw;
  const legacy = AgentDelegationScopeLegacySchema.safeParse(candidate);
  if (!legacy.success) return undefined;
  return {
    kind: 'custom',
    agentKeys: legacy.data,
  };
}

function selectedIdentifiers(
  selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
  category: AgentCategory,
  presets: readonly AgentModePreset[],
): readonly string[] | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'custom') {
    const categorySelection = selection.agentKeys[category];
    return categorySelection === 'all' ? undefined : categorySelection;
  }
  const preset = allPresets(presets).find(
    (candidate) => candidate.id === selection.teamId,
  );
  if (!preset) return undefined;
  return preset.agents[category];
}

export class AgentRosterController<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  constructor(private readonly deps: AgentRosterControllerDeps<Entry>) {}

  /** Host-supplied presets, added to the built-ins by {@link allPresets}. */
  private extraPresets(): readonly AgentModePreset[] {
    return this.deps.getPresets?.() ?? [];
  }

  /**
   * Every selectable team preset: built-ins plus the host's custom presets.
   * The one list roster pickers render — a form composing its own preset
   * list can drift from what {@link setTeam} accepts.
   */
  allPresets(): readonly AgentModePreset[] {
    return allPresets(this.extraPresets());
  }

  getSelection(): AgentRosterSelection {
    return readAgentRosterSelection(this.deps.workspaceState);
  }

  getDefaultTeamId(): string | undefined {
    return getDefaultTeamId(this.deps.globalState);
  }

  getEffectiveSelection(): AgentRosterSnapshot<Entry>['effectiveSelection'] {
    const selection = this.getSelection();
    return this.resolveEffectiveSelection(selection);
  }

  getVisibleAgents(category: AgentCategory): Entry[] {
    const effective = this.getEffectiveSelection();
    const identifiers = selectedIdentifiers(
      effective,
      category,
      this.extraPresets(),
    );
    if (identifiers === undefined) return this.deps.getAgents(category);

    const resolved = identifiers
      .map((identifier) => this.resolveEntry(category, identifier))
      .filter((entry): entry is Entry => entry !== undefined);
    return [
      ...new Map(resolved.map((entry) => [agentKeyOf(entry), entry])).values(),
    ];
  }

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined {
    return this.selectionKeys(this.getEffectiveSelection(), category);
  }

  snapshot(): AgentRosterSnapshot<Entry> {
    const selection = this.getSelection();
    const effectiveSelection = this.resolveEffectiveSelection(selection);
    const presets = this.extraPresets();
    const unresolvedNames = AGENT_CATEGORIES.flatMap((category) => {
      const identifiers = selectedIdentifiers(
        effectiveSelection,
        category,
        presets,
      );
      if (identifiers === undefined) return [];
      return identifiers
        .filter((identifier) => !this.resolveEntry(category, identifier))
        .map(agentName);
    });
    return {
      selection,
      effectiveSelection,
      defaultTeamId: this.getDefaultTeamId(),
      missingTeamId: this.missingTeamId(selection),
      agents: byCategory((category) => this.getVisibleAgents(category)),
      unresolvedNames: unique(unresolvedNames),
    };
  }

  private selectionKeys(
    selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
    category: AgentCategory,
  ): string[] | undefined {
    const identifiers = selectedIdentifiers(
      selection,
      category,
      this.extraPresets(),
    );
    if (identifiers === undefined) return undefined;

    return unique(
      identifiers.map((identifier) => {
        if (selection.kind === 'custom') return identifier;
        const entry = this.resolveEntry(category, identifier);
        return entry ? agentKeyOf(entry) : identifier;
      }),
    );
  }

  private resolveEntry(
    category: AgentCategory,
    identifier: string,
  ): Entry | undefined {
    const resolved = this.deps.resolveAgent?.(category, identifier);
    if (resolved) {
      return resolved.category === category ? resolved : undefined;
    }
    return this.deps
      .getAgents(category)
      .find((entry) => agentMatchesIdentifier(entry, identifier));
  }

  /** Team identity a selection resolves to, following inherit to the default. */
  private teamIdOf(selection: AgentRosterSelection): string | null | undefined {
    if (selection.kind === 'inherit') {
      return this.getDefaultTeamId() ?? this.deps.fallbackTeamId;
    }
    return selection.kind === 'team' ? selection.teamId : undefined;
  }

  private hasPreset(teamId: string): boolean {
    return allPresets(this.extraPresets()).some(
      (preset) => preset.id === teamId,
    );
  }

  private resolveEffectiveSelection(
    selection: AgentRosterSelection,
  ): AgentRosterSnapshot<Entry>['effectiveSelection'] {
    if (selection.kind === 'inherit') {
      const teamId = this.teamIdOf(selection);
      if (!teamId) return { kind: 'all' };
      selection = { kind: 'team', teamId };
    }
    if (selection.kind === 'team' && !this.hasPreset(selection.teamId)) {
      return { kind: 'all' };
    }
    return selection;
  }

  private missingTeamId(selection: AgentRosterSelection): string | undefined {
    const teamId = this.teamIdOf(selection);
    if (!teamId) return undefined;
    return this.hasPreset(teamId) ? undefined : teamId;
  }

  private effectiveCategorySelection(
    category: AgentCategory,
  ): AgentRosterCategorySelection {
    return this.selectionKeys(this.getEffectiveSelection(), category) ?? 'all';
  }

  private materializeCategorySelection(
    selection: AgentRosterCategorySelection,
    category: AgentCategory,
  ): string[] {
    return selection === 'all'
      ? this.deps.getAgents(category).map(agentKeyOf)
      : [...selection];
  }

  private async writeSelection(selection: AgentRosterSelection): Promise<void> {
    const parsed = AgentRosterSelectionSchema.parse(selection);
    await this.deps.workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      parsed,
    );
  }

  async setSelection(selection: AgentRosterSelection): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, () =>
      this.writeSelection(selection),
    );
  }

  async setTeam(teamId: string): Promise<void> {
    const preset = allPresets(this.extraPresets()).find(
      (candidate) => candidate.id === teamId,
    );
    if (!preset)
      throw new InvalidAgentTeamError(`Unknown agent team: ${teamId}`);
    await this.setSelection({ kind: 'team', teamId: preset.id });
  }

  async setCustom(
    agentKeys: ByCategory<AgentRosterCategorySelection>,
  ): Promise<void> {
    await this.setSelection({
      kind: 'custom',
      agentKeys: byCategory((category) => {
        const selection = agentKeys[category];
        return selection === 'all' ? 'all' : unique(selection);
      }),
    });
  }

  async setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: readonly string[],
  ): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, async () => {
      await this.writeSelection({
        kind: 'custom',
        agentKeys: byCategory((candidate) =>
          candidate === category
            ? unique(enabledKeys)
            : this.effectiveCategorySelection(candidate),
        ),
      });
    });
  }

  async setAll(): Promise<void> {
    await this.setSelection({ kind: 'all' });
  }

  async setInherited(): Promise<void> {
    await this.setSelection(INHERITED_AGENT_ROSTER);
  }

  async setAgentEnabled(input: {
    readonly category: AgentCategory;
    readonly source: AgentSource;
    readonly name: string;
    readonly enabled: boolean;
  }): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, async () => {
      const selections = byCategory((category) =>
        this.effectiveCategorySelection(category),
      );
      const target = this.materializeCategorySelection(
        selections[input.category],
        input.category,
      );
      const key = agentKeyOf(input);
      const index = target.findIndex((candidate) =>
        agentMatchesIdentifier(input, candidate),
      );
      const alreadyEnabled = index >= 0;
      if (input.enabled === alreadyEnabled) return;
      if (input.enabled) {
        target.push(key);
      } else {
        target.splice(index, 1);
      }
      await this.writeSelection({
        kind: 'custom',
        agentKeys: byCategory((category) =>
          category === input.category ? target : selections[category],
        ),
      });
    });
  }

  async removeTeamPreset(
    teamId: string,
    removePreset: () => PromiseLike<void>,
  ): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, async () => {
      const selection = this.getSelection();
      if (selection.kind === 'team' && selection.teamId === teamId) {
        await this.writeSelection({
          kind: 'custom',
          agentKeys: byCategory(
            (category) => this.selectionKeys(selection, category) ?? 'all',
          ),
        });
      }
      await removePreset();
    });
  }

  async setDefaultTeam(teamId: string): Promise<void> {
    if (!allPresets().some((preset) => preset.id === teamId)) {
      throw new InvalidAgentTeamError(
        `Only a built-in team can be the user default: ${teamId}`,
      );
    }
    await setDefaultTeamId(this.deps.globalState, teamId);
    if (this.getSelection().kind === 'inherit') {
      await this.setSelection(INHERITED_AGENT_ROSTER);
    }
  }

  async clearDefaultTeam(): Promise<void> {
    await this.deps.globalState.update(
      GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID,
      undefined,
    );
    if (this.getSelection().kind === 'inherit') {
      await this.setSelection(INHERITED_AGENT_ROSTER);
    }
  }
}
