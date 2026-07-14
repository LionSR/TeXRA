import {
  agentMatchesIdentifier,
  agentKeyOf,
  agentName,
  type AgentCategory,
  type AgentSource,
} from '@shared/schemas/agent';
import {
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
import type { StateStore } from '@platform/interfaces';

export interface AgentRosterEntry {
  readonly name: string;
  readonly source: AgentSource;
  readonly category: AgentCategory;
  readonly internal?: boolean;
}

export interface AgentRosterControllerDeps {
  readonly workspaceState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: (category: AgentCategory) => AgentRosterEntry[];
  readonly getPresets?: () => readonly AgentModePreset[];
  /** Resolve one stored identifier without collapsing exact source identity. */
  readonly resolveAgent?: (
    category: AgentCategory,
    identifier: string,
  ) => AgentRosterEntry | undefined;
  /** Host policy used only when an inherited roster has no user default. */
  readonly fallbackTeamId?: string | null;
}

const workspaceWriteQueues = new WeakMap<StateStore, Promise<void>>();

function serializeWorkspaceWrite(
  store: StateStore,
  write: () => Promise<void>,
): Promise<void> {
  const previous = workspaceWriteQueues.get(store) ?? Promise.resolve();
  const run = previous.then(write);
  // Release the queue after either outcome; callers still receive `run` and
  // therefore observe their own write error.
  workspaceWriteQueues.set(
    store,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
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

  const workflowKeys: AgentRosterCategorySelection =
    workflow === undefined ? 'all' : unique(workflow);
  const toolUseKeys: AgentRosterCategorySelection =
    toolUse === undefined ? 'all' : unique(toolUse);
  if (workflowKeys === 'all' && toolUseKeys === 'all') return { kind: 'all' };

  const matchingPreset =
    workflowKeys === 'all' || toolUseKeys === 'all'
      ? undefined
      : allPresets(presets).find(
          (preset) =>
            identifiersEqual(workflowKeys, preset.workflowAgents) &&
            identifiersEqual(toolUseKeys, preset.toolUseAgents),
        );
  if (matchingPreset) {
    return { kind: 'team', teamId: matchingPreset.id };
  }
  return {
    kind: 'custom',
    workflowAgentKeys: workflowKeys,
    toolUseAgentKeys: toolUseKeys,
  };
}

function selectedIdentifiers(
  selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
  category: AgentCategory,
  presets: readonly AgentModePreset[],
): readonly string[] | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'custom') {
    const categorySelection =
      category === 'workflow'
        ? selection.workflowAgentKeys
        : selection.toolUseAgentKeys;
    return categorySelection === 'all' ? undefined : categorySelection;
  }
  const preset = allPresets(presets).find(
    (candidate) => candidate.id === selection.teamId,
  );
  if (!preset) return undefined;
  return category === 'workflow' ? preset.workflowAgents : preset.toolUseAgents;
}

export class AgentRosterController {
  constructor(private readonly deps: AgentRosterControllerDeps) {}

  getSelection(): AgentRosterSelection {
    return readAgentRosterSelection(
      this.deps.workspaceState,
      this.deps.getPresets?.() ?? [],
    );
  }

  getDefaultTeamId(): string | undefined {
    return getDefaultTeamId(this.deps.globalState);
  }

  getEffectiveSelection(): AgentRosterSnapshot['effectiveSelection'] {
    const selection = this.getSelection();
    return this.resolveEffectiveSelection(selection);
  }

  getVisibleAgents(category: AgentCategory): AgentRosterEntry[] {
    const effective = this.getEffectiveSelection();
    const identifiers = selectedIdentifiers(
      effective,
      category,
      this.deps.getPresets?.() ?? [],
    );
    if (identifiers === undefined) return this.deps.getAgents(category);

    const resolved = identifiers
      .map((identifier) => this.resolveEntry(category, identifier))
      .filter((entry): entry is AgentRosterEntry => entry !== undefined);
    return [
      ...new Map(resolved.map((entry) => [agentKeyOf(entry), entry])).values(),
    ];
  }

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys(category: AgentCategory): string[] | undefined {
    return this.selectionKeys(this.getEffectiveSelection(), category);
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
        return identifiers
          .filter((identifier) => !this.resolveEntry(category, identifier))
          .map(agentName);
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
        const entry = this.resolveEntry(category, identifier);
        return entry ? agentKeyOf(entry) : identifier;
      }),
    );
  }

  private resolveEntry(
    category: AgentCategory,
    identifier: string,
  ): AgentRosterEntry | undefined {
    const resolved = this.deps.resolveAgent?.(category, identifier);
    if (resolved) {
      return resolved.category === category && !resolved.internal
        ? resolved
        : undefined;
    }
    return this.deps
      .getAgents(category)
      .find((entry) => agentMatchesIdentifier(entry, identifier));
  }

  private resolveEffectiveSelection(
    selection: AgentRosterSelection,
  ): AgentRosterSnapshot['effectiveSelection'] {
    if (selection.kind === 'inherit') {
      const teamId = this.getDefaultTeamId() ?? this.deps.fallbackTeamId;
      if (!teamId) return { kind: 'all' };
      selection = { kind: 'team', teamId };
    }
    if (
      selection.kind === 'team' &&
      !allPresets(this.deps.getPresets?.() ?? []).some(
        (preset) => preset.id === selection.teamId,
      )
    ) {
      return { kind: 'all' };
    }
    return selection;
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
    const effective = this.resolveEffectiveSelection(parsed);
    const previous = {
      selection: this.deps.workspaceState.get<unknown>(
        WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      ),
      workflow: this.deps.workspaceState.get<unknown>(
        WorkspaceStateKey.ENABLED_AGENTS,
      ),
      toolUse: this.deps.workspaceState.get<unknown>(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    };
    const workflow = this.selectionKeys(effective, 'workflow');
    const toolUse = this.selectionKeys(effective, 'toolUse');

    // Write compatibility mirrors first and the canonical selection last. The
    // canonical write is the commit point for current hosts.
    try {
      await this.deps.workspaceState.update(
        WorkspaceStateKey.ENABLED_AGENTS,
        workflow,
      );
      await this.deps.workspaceState.update(
        WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        toolUse,
      );
      await this.deps.workspaceState.update(
        WorkspaceStateKey.AGENT_ROSTER_SELECTION,
        parsed,
      );
    } catch (error: unknown) {
      await Promise.allSettled([
        this.deps.workspaceState.update(
          WorkspaceStateKey.ENABLED_AGENTS,
          previous.workflow,
        ),
        this.deps.workspaceState.update(
          WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
          previous.toolUse,
        ),
        this.deps.workspaceState.update(
          WorkspaceStateKey.AGENT_ROSTER_SELECTION,
          previous.selection,
        ),
      ]);
      throw error;
    }
  }

  async setSelection(selection: AgentRosterSelection): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, () =>
      this.writeSelection(selection),
    );
  }

  async setTeam(teamId: string): Promise<void> {
    const preset = allPresets(this.deps.getPresets?.() ?? []).find(
      (candidate) => candidate.id === teamId,
    );
    if (!preset) throw new Error(`Unknown agent team: ${teamId}`);
    await this.setSelection({ kind: 'team', teamId: preset.id });
  }

  async setCustom(input: {
    readonly workflowAgentKeys: AgentRosterCategorySelection;
    readonly toolUseAgentKeys: AgentRosterCategorySelection;
  }): Promise<void> {
    await this.setSelection({
      kind: 'custom',
      workflowAgentKeys:
        input.workflowAgentKeys === 'all'
          ? 'all'
          : unique(input.workflowAgentKeys),
      toolUseAgentKeys:
        input.toolUseAgentKeys === 'all'
          ? 'all'
          : unique(input.toolUseAgentKeys),
    });
  }

  async setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: readonly string[],
  ): Promise<void> {
    await serializeWorkspaceWrite(this.deps.workspaceState, async () => {
      await this.writeSelection({
        kind: 'custom',
        workflowAgentKeys:
          category === 'workflow'
            ? unique(enabledKeys)
            : this.effectiveCategorySelection('workflow'),
        toolUseAgentKeys:
          category === 'toolUse'
            ? unique(enabledKeys)
            : this.effectiveCategorySelection('toolUse'),
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
      const workflowSelection = this.effectiveCategorySelection('workflow');
      const toolUseSelection = this.effectiveCategorySelection('toolUse');
      const targetSelection =
        input.category === 'workflow' ? workflowSelection : toolUseSelection;
      const target = this.materializeCategorySelection(
        targetSelection,
        input.category,
      );
      const key = agentKeyOf(input);
      const index = target.findIndex((candidate) =>
        agentMatchesIdentifier(input, candidate),
      );
      if (input.enabled && index < 0) target.push(key);
      if (!input.enabled && index >= 0) target.splice(index, 1);
      await this.writeSelection({
        kind: 'custom',
        workflowAgentKeys:
          input.category === 'workflow' ? target : workflowSelection,
        toolUseAgentKeys:
          input.category === 'toolUse' ? target : toolUseSelection,
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
          workflowAgentKeys: this.selectionKeys(selection, 'workflow') ?? 'all',
          toolUseAgentKeys: this.selectionKeys(selection, 'toolUse') ?? 'all',
        });
      }
      await removePreset();
    });
  }

  async setDefaultTeam(teamId: string): Promise<void> {
    if (!allPresets().some((preset) => preset.id === teamId)) {
      throw new Error(
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
