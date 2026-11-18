import { Effect, Result, Schema } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import {
  Settings,
  type StateReadFailed,
  type StateStore,
  type StateWriteFailed,
} from '@shared/config/settings';
import type { WorkspaceAgentsSelection, AgentSource } from '@shared/schemas';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  ALL_WORKSPACE_AGENTS,
  WorkspaceAgentsSelectionSchema,
} from '@shared/schemas';

import {
  HIDDEN_CUSTOM_AGENTS_KEY,
  WORKSPACE_AGENTS_KEY,
  storedHidden,
  unlistedCustomAgents,
  visibleAgents,
  withCustomChoices,
} from './workspaceAgentsState';

const SELECTION = WORKSPACE_AGENTS_KEY.key;
const HIDDEN = HIDDEN_CUSTOM_AGENTS_KEY.key;

export interface WorkspaceAgentsEntry {
  readonly name: string;
  readonly source: AgentSource;
}

export interface WorkspaceAgentsControllerDeps<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  readonly repoState: StateStore;
  readonly getAgents: () => Entry[];
  /**
   * Resolve one stored identifier without collapsing exact source identity.
   * The controller applies no fallback around this, so an implementation owns
   * the whole contract: match a bare name against the deduplicated agents,
   * and a source-qualified key exactly. `AgentCatalog.get` is the production
   * implementation.
   */
  readonly resolveAgent: (identifier: string) => Entry | undefined;
}

/** A selection in the form the store keeps. */
const storedSelection = (selection: WorkspaceAgentsSelection) =>
  Schema.decodeSync(WorkspaceAgentsSelectionSchema)(selection);

/**
 * The stored selection a toggle starts from. One that no longer decodes
 * reads as every agent, which is what each read showed the workspace, and
 * comes back with its error for the toggle to report.
 */
function shownSelection(stored: unknown): {
  readonly selection: WorkspaceAgentsSelection;
  readonly invalid?: string;
} {
  const decoded = Schema.decodeUnknownResult(WORKSPACE_AGENTS_KEY.schema)(
    stored,
  );
  return Result.isSuccess(decoded)
    ? { selection: decoded.success }
    : { selection: ALL_WORKSPACE_AGENTS, invalid: decoded.failure.message };
}

/** Say that a toggle started from every agent because the stored selection
 *  did not decode. A list the toggle then wrote replaced that value. */
const reportInvalid = (invalid: string | undefined) =>
  invalid === undefined
    ? Effect.void
    : Effect.logWarning(
        `Invalid stored ${SELECTION}; the toggle started from every agent, as the workspace showed.`,
        invalid,
      ).pipe(withLogChannel('settings'));

export class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  private readonly deps: WorkspaceAgentsControllerDeps<Entry>;
  constructor(deps: WorkspaceAgentsControllerDeps<Entry>) {
    this.deps = deps;
  }

  private getSelection() {
    return Settings.state(this.deps.repoState, WORKSPACE_AGENTS_KEY);
  }

  private getHidden() {
    return Settings.state(this.deps.repoState, HIDDEN_CUSTOM_AGENTS_KEY);
  }

  /** The agents this workspace shows: its selection over the catalog, and
   *  the custom agents it does not list. */
  readonly visible = Effect.fn('WorkspaceAgentsController.visible')(
    { self: this },
    function* () {
      const selection = yield* this.getSelection();
      const hidden = yield* this.getHidden();
      const agents = this.deps.getAgents();
      if (selection.kind === 'all') return visibleAgents(hidden, agents);
      const { entries } = this.resolveIdentifiers(selection.agentKeys);
      return [
        ...entries,
        ...unlistedCustomAgents(hidden, agents, entries.map(agentKeyOf)),
      ];
    },
  );

  /** Return the stored identifiers, including unavailable members. */
  getEnabledAgentKeys() {
    return Effect.flatMap(this.getSelection(), (selection) =>
      Effect.map(this.getHidden(), (hidden) =>
        this.selectionKeys(selection, hidden),
      ),
    );
  }

  readonly snapshot = Effect.fn('WorkspaceAgentsController.snapshot')(
    { self: this },
    function* () {
      const selection = yield* this.getSelection();
      const unresolvedNames =
        selection.kind === 'all'
          ? []
          : this.resolveIdentifiers(selection.agentKeys).missing.map(agentName);
      return { selection, unresolvedNames: [...new Set(unresolvedNames)] };
    },
  );

  /** The keys a selection enables, the custom agents it does not list
   *  included; `undefined` for every agent. */
  private selectionKeys(
    selection: WorkspaceAgentsSelection,
    hidden: readonly string[],
  ) {
    if (selection.kind === 'all') return undefined;
    const keys = [...new Set(selection.agentKeys)];
    const unlisted = unlistedCustomAgents(hidden, this.deps.getAgents(), keys);
    return [...keys, ...unlisted.map(agentKeyOf)];
  }

  /**
   * The one walk from stored identifiers to catalog entries: `entries` are
   * the resolved members deduplicated by key, `missing` the identifiers with
   * no entry.
   */
  private resolveIdentifiers(identifiers: readonly string[]) {
    const entries = new Map<string, Entry>();
    const missing: string[] = [];
    for (const identifier of identifiers) {
      const entry = this.deps.resolveAgent(identifier);
      if (entry) entries.set(agentKeyOf(entry), entry);
      else missing.push(identifier);
    }
    return { entries: [...entries.values()], missing };
  }

  /**
   * Store the selection this workspace runs, with the hidden list it
   * implies, in one store step. A custom list records its choices, and `all`
   * shows the hidden custom agents again.
   */
  readonly select = Effect.fn('WorkspaceAgentsController.select')(
    { self: this },
    function* (selection: WorkspaceAgentsSelection) {
      const agents = this.deps.getAgents();
      const stored = storedSelection(
        selection.kind === 'custom'
          ? { kind: 'custom', agentKeys: [...new Set(selection.agentKeys)] }
          : selection,
      );
      yield* this.deps.repoState.modify([SELECTION, HIDDEN], (current) => {
        const hidden: Result.Result<unknown, StateReadFailed> =
          selection.kind === 'custom'
            ? Result.map(storedHidden(current[HIDDEN]), (keys) =>
                withCustomChoices(keys, agents, selection.agentKeys),
              )
            : Result.succeed([]);
        return Result.map(
          hidden,
          (next) =>
            [undefined, { [SELECTION]: stored, [HIDDEN]: next }] as const,
        );
      });
    },
  );

  /** Turn agents of one source on or off, in one store step: the selection
   *  becomes the custom list it now shows, unless no agent changed. */
  setAgentEnabled(input: {
    readonly source: AgentSource;
    readonly name: string | readonly string[];
    readonly enabled: boolean;
  }): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return this.deps.repoState
      .modify([SELECTION, HIDDEN], (current) =>
        Result.map(storedHidden(current[HIDDEN]), (hidden) => {
          const agents = this.deps.getAgents();
          const { selection, invalid } = shownSelection(current[SELECTION]);
          const target = [
            ...(this.selectionKeys(selection, hidden) ??
              visibleAgents(hidden, agents).map(agentKeyOf)),
          ];
          // Every name flips the same way, so the length says if any changed.
          const before = target.length;
          for (const name of [input.name].flat()) {
            const agent = { source: input.source, name };
            const index = target.findIndex((candidate) =>
              agentMatchesIdentifier(agent, candidate),
            );
            if (input.enabled === index >= 0) continue;
            if (input.enabled) target.push(agentKeyOf(agent));
            else target.splice(index, 1);
          }
          if (target.length === before) return [invalid] as const;
          return [
            invalid,
            {
              [SELECTION]: storedSelection({
                kind: 'custom',
                agentKeys: target,
              }),
              [HIDDEN]: withCustomChoices(hidden, agents, target),
            },
          ] as const;
        }),
      )
      .pipe(Effect.flatMap(reportInvalid));
  }
}
