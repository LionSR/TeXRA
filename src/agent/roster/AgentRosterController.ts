import {
  agentKeyOf,
  agentName,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import {
  AgentRosterSelectionSchema,
  INHERITED_AGENT_ROSTER,
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
import type { StateStore } from '@platform/interfaces';

export interface AgentRosterEntry {
  readonly name: string;
  readonly source: AgentSource;
  readonly category: AgentCategory;
}

export interface AgentRosterControllerDeps {
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: (category: AgentCategory) => AgentRosterEntry[];
  readonly getPresets?: () => readonly AgentModePreset[];
  readonly resolveIdentifier?: (
    category: AgentCategory,
    identifier: string,
  ) => string;
  /** Host policy used only when an inherited roster has no user default. */
  readonly fallbackTeamId?: string | null;
}

export interface AgentRosterSnapshot {
  readonly selection: AgentRosterSelection;
  readonly effectiveSelection: Exclude<
    AgentRosterSelection,
    { readonly kind: 'inherit' }
  >;
  readonly defaultTeamId?: string;
  readonly workflowAgents: AgentRosterEntry[];
  readonly toolUseAgents: AgentRosterEntry[];
  readonly unresolvedNames: string[];
}

function stateKey(category: AgentCategory): WorkspaceStateKey {
  return category === 'workflow'
    ? WorkspaceStateKey.ENABLED_AGENTS
    : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS;
}

function allPresets(
  extra: readonly AgentModePreset[] = [],
): readonly AgentModePreset[] {
  return [STARTER_AGENT_MODE_PRESET, ...AGENT_MODE_PRESETS, ...extra];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function identifiersEqual(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const actualNames = new Set(actual.map(agentName));
  const expectedNames = new Set(expected.map(agentName));
  return (
    actualNames.size === expectedNames.size &&
    [...actualNames].every((name) => expectedNames.has(name))
  );
}

/** Read the canonical selection, deriving a stable legacy value when needed. */
export function readAgentRosterSelection(
  workspaceState: StateStore,
  presets: readonly AgentModePreset[] = [],
  allAgentKeys?: Readonly<Record<AgentCategory, readonly string[]>>,
): AgentRosterSelection {
  const raw = workspaceState.get<unknown>(
    WorkspaceStateKey.AGENT_ROSTER_SELECTION,
  );
  if (raw !== undefined) return AgentRosterSelectionSchema.parse(raw);

  const workflow = workspaceState.get<string[]>(
    WorkspaceStateKey.ENABLED_AGENTS,
  );
  const toolUse = workspaceState.get<string[]>(
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  );
  if (workflow === undefined && toolUse === undefined) {
    return INHERITED_AGENT_ROSTER;
  }

  const workflowKeys = workflow ?? allAgentKeys?.workflow ?? [];
  const toolUseKeys = toolUse ?? allAgentKeys?.toolUse ?? [];
  const matchingPreset = allPresets(presets).find(
    (preset) =>
      identifiersEqual(workflowKeys, preset.workflowAgents) &&
      identifiersEqual(toolUseKeys, preset.toolUseAgents),
  );
  if (matchingPreset) {
    return { kind: 'team', teamId: matchingPreset.id };
  }
  return {
    kind: 'custom',
    workflowAgentKeys: unique(workflowKeys),
    toolUseAgentKeys: unique(toolUseKeys),
  };
}

function selectedIdentifiers(
  selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
  category: AgentCategory,
  presets: readonly AgentModePreset[],
): readonly string[] | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'custom') {
    return category === 'workflow'
      ? selection.workflowAgentKeys
      : selection.toolUseAgentKeys;
  }
  const preset = allPresets(presets).find(
    (candidate) => candidate.id === selection.teamId,
  );
  if (!preset) return [];
  return category === 'workflow' ? preset.workflowAgents : preset.toolUseAgents;
}

function filterEntries(
  entries: readonly AgentRosterEntry[],
  identifiers: readonly string[] | undefined,
  resolveIdentifier: (identifier: string) => string = agentName,
): AgentRosterEntry[] {
  if (identifiers === undefined) return [...entries];
  const names = new Set(identifiers.map(resolveIdentifier));
  return entries.filter((entry) => names.has(entry.name));
}

export class AgentRosterController {
  constructor(private readonly deps: AgentRosterControllerDeps) {}

  getSelection(): AgentRosterSelection {
    return readAgentRosterSelection(
      this.deps.workspaceState,
      this.deps.getPresets?.() ?? [],
      {
        workflow: this.deps.getAgents('workflow').map(agentKeyOf),
        toolUse: this.deps.getAgents('toolUse').map(agentKeyOf),
      },
    );
  }

  getDefaultTeamId(): string | undefined {
    return getDefaultTeamId(this.deps.globalState);
  }

  getEffectiveSelection(): AgentRosterSnapshot['effectiveSelection'] {
    const selection = this.getSelection();
    if (selection.kind !== 'inherit') return selection;
    const teamId = this.getDefaultTeamId() ?? this.deps.fallbackTeamId;
    return teamId ? { kind: 'team', teamId } : { kind: 'all' };
  }

  getVisibleAgents(category: AgentCategory): AgentRosterEntry[] {
    const effective = this.getEffectiveSelection();
    return filterEntries(
      this.deps.getAgents(category),
      selectedIdentifiers(effective, category, this.deps.getPresets?.() ?? []),
      (identifier) =>
        this.deps.resolveIdentifier?.(category, identifier) ??
        agentName(identifier),
    );
  }

  snapshot(): AgentRosterSnapshot {
    const selection = this.getSelection();
    const effectiveSelection = this.getEffectiveSelection();
    const presets = this.deps.getPresets?.() ?? [];
    const unresolvedNames = (['workflow', 'toolUse'] as const).flatMap(
      (category) => {
        const identifiers = selectedIdentifiers(
          effectiveSelection,
          category,
          presets,
        );
        if (identifiers === undefined) return [];
        const resolvedNames = new Set(
          this.deps.getAgents(category).map((entry) => entry.name),
        );
        return identifiers
          .map(
            (identifier) =>
              this.deps.resolveIdentifier?.(category, identifier) ??
              agentName(identifier),
          )
          .filter((name) => !resolvedNames.has(name));
      },
    );
    return {
      selection,
      effectiveSelection,
      defaultTeamId: this.getDefaultTeamId(),
      workflowAgents: this.getVisibleAgents('workflow'),
      toolUseAgents: this.getVisibleAgents('toolUse'),
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
      this.deps.getPresets?.() ?? [],
    );
    if (identifiers === undefined) return undefined;

    return unique(
      identifiers.map((identifier) => {
        if (selection.kind === 'custom') return identifier;
        const name =
          this.deps.resolveIdentifier?.(category, identifier) ??
          agentName(identifier);
        const entry = this.deps
          .getAgents(category)
          .find((candidate) => candidate.name === name);
        return entry ? agentKeyOf(entry) : identifier;
      }),
    );
  }

  private effectiveAgentKeys(category: AgentCategory): string[] {
    return (
      this.selectionKeys(this.getEffectiveSelection(), category) ??
      this.deps.getAgents(category).map(agentKeyOf)
    );
  }

  async setSelection(selection: AgentRosterSelection): Promise<void> {
    const parsed = AgentRosterSelectionSchema.parse(selection);
    const effective =
      parsed.kind === 'inherit'
        ? (() => {
            const teamId = this.getDefaultTeamId() ?? this.deps.fallbackTeamId;
            return teamId
              ? ({ kind: 'team', teamId } as const)
              : ({ kind: 'all' } as const);
          })()
        : parsed;

    await this.deps.workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      parsed,
    );

    // Compatibility mirrors for older hosts. The canonical key above is the
    // only source used by current code to choose the workspace roster.
    for (const category of ['workflow', 'toolUse'] as const) {
      const compatibilityKeys = this.selectionKeys(effective, category);
      await this.deps.workspaceState.update(
        stateKey(category),
        compatibilityKeys,
      );
    }
  }

  async setTeam(teamId: string): Promise<void> {
    const preset = allPresets(this.deps.getPresets?.() ?? []).find(
      (candidate) => candidate.id === teamId,
    );
    if (!preset) throw new Error(`Unknown agent team: ${teamId}`);
    await this.setSelection({ kind: 'team', teamId: preset.id });
  }

  async setCustom(input: {
    readonly workflowAgentKeys: readonly string[];
    readonly toolUseAgentKeys: readonly string[];
  }): Promise<void> {
    await this.setSelection({
      kind: 'custom',
      workflowAgentKeys: unique(input.workflowAgentKeys),
      toolUseAgentKeys: unique(input.toolUseAgentKeys),
    });
  }

  async setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: readonly string[],
  ): Promise<void> {
    await this.setCustom({
      workflowAgentKeys:
        category === 'workflow'
          ? enabledKeys
          : this.effectiveAgentKeys('workflow'),
      toolUseAgentKeys:
        category === 'toolUse'
          ? enabledKeys
          : this.effectiveAgentKeys('toolUse'),
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
    const workflowAgentKeys = this.effectiveAgentKeys('workflow');
    const toolUseAgentKeys = this.effectiveAgentKeys('toolUse');
    const target =
      input.category === 'workflow' ? workflowAgentKeys : toolUseAgentKeys;
    const key = agentKeyOf(input);
    const index = target.findIndex(
      (candidate) => agentName(candidate) === input.name,
    );
    if (input.enabled && index < 0) target.push(key);
    if (!input.enabled && index >= 0) target.splice(index, 1);
    await this.setCustom({ workflowAgentKeys, toolUseAgentKeys });
  }

  async setDefaultTeam(teamId: string): Promise<void> {
    if (!allPresets().some((preset) => preset.id === teamId)) {
      throw new Error(
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
