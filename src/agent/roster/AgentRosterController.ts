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
  readonly resolveAgent: (
    category: AgentCategory,
    identifier: string,
  ) => Entry | undefined;
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

interface ResolvedRosterSelection {
  readonly effectiveSelection: AgentRosterSnapshot['effectiveSelection'];
  readonly defaultTeamId?: string;
  readonly missingTeamId?: string;
  readonly presets: readonly AgentModePreset[];
}

/**
 * Read the canonical workspace selection. A value that does not parse is
 * tried against the legacy pair-shaped format (`{workflowAgentKeys,
 * toolUseAgentKeys}`, with or without a stray `kind` field) via the existing
 * AgentDelegationScopeLegacySchema. The compatibility reader is deliberately
 * pure: only the serialized mutation methods below own durable roster writes,
 * so reading old state cannot race a newer user selection.
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
  const legacy = parseLegacySelection(raw);
  if (legacy) return legacy;
  console.warn(
    `[agentRoster] Ignoring malformed roster selection; falling back to ` +
      `the inherited roster: ${parsed.error.message}`,
  );
  return INHERITED_AGENT_ROSTER;
}

function parseLegacySelection(raw: unknown): AgentRosterSelection | undefined {
  // The legacy pair-shaped value may carry a stray `kind` field: an
  // intermediate version wrote `{kind: 'custom', workflowAgentKeys,
  // toolUseAgentKeys}` under AGENT_ROSTER_SELECTION, which neither the
  // canonical schema (missing `agentKeys`) nor the strict legacy schema
  // (rejects `kind`) accepts. Drop the discriminant before parsing so both
  // the pure and hybrid legacy shapes normalize to the same canonical value.
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
  const preset = presets.find((candidate) => candidate.id === selection.teamId);
  if (!preset) return undefined;
  return preset.agents[category];
}

export class AgentRosterController<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  constructor(private readonly deps: AgentRosterControllerDeps<Entry>) {}

  /**
   * Every selectable team preset: built-ins plus the host's custom presets.
   * The one list roster pickers render — a form composing its own preset
   * list can drift from what {@link setTeam} accepts.
   */
  allPresets(): readonly AgentModePreset[] {
    return [
      STARTER_AGENT_MODE_PRESET,
      ...AGENT_MODE_PRESETS,
      ...(this.deps.getPresets?.() ?? []),
    ];
  }

  getSelection(): AgentRosterSelection {
    return readAgentRosterSelection(this.deps.workspaceState);
  }

  getDefaultTeamId(): string | undefined {
    return getDefaultTeamId(this.deps.globalState);
  }

  getEffectiveSelection(): AgentRosterSnapshot<Entry>['effectiveSelection'] {
    return this.resolveSelection(this.getSelection()).effectiveSelection;
  }

  /** The effective team selected for this workspace, if the roster uses one. */
  getActiveTeamId(): string | null {
    const selection = this.getEffectiveSelection();
    return selection.kind === 'team' ? selection.teamId : null;
  }

  getVisibleAgents(category: AgentCategory): Entry[] {
    const resolved = this.resolveSelection(this.getSelection());
    return this.visibleAgents(
      resolved.effectiveSelection,
      category,
      resolved.presets,
    );
  }

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined {
    const resolved = this.resolveSelection(this.getSelection());
    return this.selectionKeys(
      resolved.effectiveSelection,
      category,
      resolved.presets,
    );
  }

  snapshot(): AgentRosterSnapshot<Entry> {
    const selection = this.getSelection();
    const resolved = this.resolveSelection(selection);
    const unresolvedNames = AGENT_CATEGORIES.flatMap((category) => {
      const identifiers = selectedIdentifiers(
        resolved.effectiveSelection,
        category,
        resolved.presets,
      );
      if (identifiers === undefined) return [];
      return identifiers
        .filter((identifier) => !this.deps.resolveAgent(category, identifier))
        .map(agentName);
    });
    return {
      selection,
      effectiveSelection: resolved.effectiveSelection,
      defaultTeamId: resolved.defaultTeamId,
      missingTeamId: resolved.missingTeamId,
      agents: byCategory((category) =>
        this.visibleAgents(
          resolved.effectiveSelection,
          category,
          resolved.presets,
        ),
      ),
      unresolvedNames: unique(unresolvedNames),
    };
  }

  private resolveSelection(
    selection: AgentRosterSelection,
  ): ResolvedRosterSelection {
    const defaultTeamId = this.getDefaultTeamId();
    const presets = this.allPresets();
    let teamId: string | undefined;
    if (selection.kind === 'inherit') teamId = defaultTeamId;
    if (selection.kind === 'team') teamId = selection.teamId;
    const missingTeamId =
      teamId && !presets.some((preset) => preset.id === teamId)
        ? teamId
        : undefined;
    let effectiveSelection: AgentRosterSnapshot['effectiveSelection'];
    if (selection.kind === 'inherit') {
      effectiveSelection = teamId ? { kind: 'team', teamId } : { kind: 'all' };
    } else {
      effectiveSelection = selection;
    }
    if (missingTeamId !== undefined) effectiveSelection = { kind: 'all' };
    return { effectiveSelection, defaultTeamId, missingTeamId, presets };
  }

  private visibleAgents(
    selection: AgentRosterSnapshot['effectiveSelection'],
    category: AgentCategory,
    presets: readonly AgentModePreset[],
  ): Entry[] {
    const identifiers = selectedIdentifiers(selection, category, presets);
    if (identifiers === undefined) return this.deps.getAgents(category);

    const resolved = identifiers
      .map((identifier) => this.deps.resolveAgent(category, identifier))
      .filter((entry): entry is Entry => entry !== undefined);
    return [
      ...new Map(resolved.map((entry) => [agentKeyOf(entry), entry])).values(),
    ];
  }

  private selectionKeys(
    selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
    category: AgentCategory,
    presets: readonly AgentModePreset[],
  ): string[] | undefined {
    const identifiers = selectedIdentifiers(selection, category, presets);
    if (identifiers === undefined) return undefined;

    return unique(
      identifiers.map((identifier) => {
        if (selection.kind === 'custom') return identifier;
        const entry = this.deps.resolveAgent(category, identifier);
        return entry ? agentKeyOf(entry) : identifier;
      }),
    );
  }

  private categorySelection(
    resolved: ResolvedRosterSelection,
    category: AgentCategory,
  ): AgentRosterCategorySelection {
    return (
      this.selectionKeys(
        resolved.effectiveSelection,
        category,
        resolved.presets,
      ) ?? 'all'
    );
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

  private async setSelection(selection: AgentRosterSelection): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, () =>
      this.writeSelection(selection),
    );
  }

  async setTeam(teamId: string): Promise<void> {
    const preset = this.allPresets().find(
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
      const resolved = this.resolveSelection(this.getSelection());
      await this.writeSelection({
        kind: 'custom',
        agentKeys: byCategory((candidate) =>
          candidate === category
            ? unique(enabledKeys)
            : this.categorySelection(resolved, candidate),
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
      const resolved = this.resolveSelection(this.getSelection());
      const selections = byCategory((category) =>
        this.categorySelection(resolved, category),
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
        const presets = this.allPresets();
        await this.writeSelection({
          kind: 'custom',
          agentKeys: byCategory(
            (category) =>
              this.selectionKeys(selection, category, presets) ?? 'all',
          ),
        });
      }
      await removePreset();
    });
  }

  async setDefaultTeam(teamId: string): Promise<void> {
    const builtInPresets = [STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS];
    if (!builtInPresets.some((preset) => preset.id === teamId)) {
      throw new InvalidAgentTeamError(
        `Only a built-in team can be the user default: ${teamId}`,
      );
    }
    await setDefaultTeamId(this.deps.globalState, teamId);
  }

  async clearDefaultTeam(): Promise<void> {
    await this.deps.globalState.update(
      GlobalStateKey.ONBOARDING_DEFAULT_TEAM_ID,
      undefined,
    );
  }
}
