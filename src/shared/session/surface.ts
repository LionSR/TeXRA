/**
 * The Surface (PRD one-fold-three-renderers, section 9): every interaction
 * fact a renderer owns for one view instance and one open session. It is
 * the second of the two records a component reads (`SessionView` is the
 * first) and the only place selection, drafts, expansion, focus, scroll,
 * and layout live. Components never hold their own copy; they read the
 * record and dispatch a `SurfaceAction`, and the root applies it through
 * `applySurfaceAction`.
 *
 * The signal record holds `Map`s. Webview state crosses `JSON.stringify`,
 * where a `Map` serializes to `{}`, so the persisted form beside it is a Zod
 * schema whose maps are entry arrays, rebuilt into `Map`s at load.
 */
import { z } from 'zod';

import {
  InquiryDraftSchema,
  MainViewPersistedStateSchema,
  StreamTabIdSchema,
  type InquiryDraft,
  type StreamTabId,
} from '@shared/schemas';
import type { ExtractedClipboardImage } from '@shared/utils/clipboardImages';
import type { SessionView } from './sessionView';

/**
 * The new-task composer's selections: `MainViewPersistedState` minus the
 * host-derived fields. `openedFiles` and the LaTeXDiffs visibility are the
 * host's (`openedFiles`) or the Tools sheet's (`toolsSheetOpen` below), so
 * a per-view copy would answer a question the host snapshot already owns.
 */
export const LaunchSurfaceSchema = MainViewPersistedStateSchema.omit({
  openedFiles: true,
  latexdiffsVisible: true,
});
type LaunchSurface = z.infer<typeof LaunchSurfaceSchema>;

/** A change to the launcher: the per-category records merge one level
 *  deep, so a host can name the tool-use agent without knowing the
 *  workflow one. Zod because the host's `surface.action` carries it. */
const PerCategoryPatchSchema = z
  .object({ workflow: z.string().optional(), toolUse: z.string().optional() })
  .optional();
export const LaunchPatchSchema = LaunchSurfaceSchema.partial().extend({
  agent: PerCategoryPatchSchema,
  instruction: PerCategoryPatchSchema,
});
type LaunchPatch = z.infer<typeof LaunchPatchSchema>;

/** A follow-up in progress for one stream. Only `text` persists. */
export interface Draft {
  readonly text: string;
  readonly images: readonly ExtractedClipboardImage[];
  readonly polished: string | null;
  readonly transcribed: string | null;
}

export const EMPTY_DRAFT: Draft = {
  text: '',
  images: [],
  polished: null,
  transcribed: null,
};

const ExpansionOverrideSchema = z.enum(['expanded', 'collapsed']);
type ExpansionOverride = z.infer<typeof ExpansionOverrideSchema>;

/**
 * The desktop workbench layout rides in the surface as the desktop's own
 * record: `packages/desktop` declares its shape and the shared record only
 * carries it through persistence. Null on hosts without a workbench.
 */
type WorkbenchLayout = Readonly<Record<string, unknown>>;

export interface Surface {
  /** Which paper this surface is for; the layer key. Never persisted. */
  readonly session: string;
  /**
   * A preference, not a pointer: read it through `resolveSelected`. `null`
   * is the New-task state and resolves to itself.
   */
  readonly selected: StreamTabId | null;
  readonly drafts: ReadonlyMap<StreamTabId, Draft>;
  readonly launch: LaunchSurface;
  /** Keyed by `${InquiryThreadId}#${turn}`, never by stream. */
  readonly inquiryDrafts: ReadonlyMap<string, InquiryDraft>;
  /** The user's override on the stream tree; `forceExpanded` outranks it. */
  readonly expanded: ReadonlyMap<StreamTabId, ExpansionOverride>;
  /** Task groups and workflow row groups inside a transcript, per stream. */
  readonly groups: ReadonlyMap<StreamTabId, ReadonlyMap<string, boolean>>;
  /** Never persisted. */
  readonly focusedRow: string | null;
  /** Run-board tab strip; resolved at read like `selected`. */
  readonly phase: ReadonlyMap<StreamTabId, string>;
  readonly scroll: ReadonlyMap<StreamTabId, number>;
  readonly drawerOpen: boolean;
  readonly toolsSheetOpen: boolean;
  /** The output list's "where files are stored" hint, dismissed once. */
  readonly storageHintDismissed: boolean;
  /** The drawer's filter. Never persisted. */
  readonly search: string;
  readonly workbench: WorkbenchLayout | null;
}

function entries<K extends z.ZodType, V extends z.ZodType>(key: K, value: V) {
  return z.array(z.tuple([key, value])).prefault([]);
}

/**
 * The persisted form: interaction state only, per view and session. A
 * missing field takes its default before validation (`prefault`), because
 * a surface saved by an older build is still a valid surface; a corrupt
 * field fails the parse loudly rather than becoming a silent default.
 */
export const PersistedSurfaceSchema = z.object({
  selected: StreamTabIdSchema.nullable().prefault(null),
  launch: LaunchSurfaceSchema.prefault({}),
  /** Text only; images and the polished and transcribed variants are not. */
  drafts: entries(StreamTabIdSchema, z.string()),
  inquiryDrafts: entries(z.string(), InquiryDraftSchema),
  expanded: entries(StreamTabIdSchema, ExpansionOverrideSchema),
  groups: entries(StreamTabIdSchema, entries(z.string(), z.boolean())),
  phase: entries(StreamTabIdSchema, z.string()),
  scroll: entries(StreamTabIdSchema, z.number()),
  drawerOpen: z.boolean().prefault(false),
  storageHintDismissed: z.boolean().prefault(false),
  workbench: z.record(z.string(), z.unknown()).nullable().prefault(null),
});
export type PersistedSurface = z.infer<typeof PersistedSurfaceSchema>;

export function emptySurface(session: string): Surface {
  return loadSurface(session, PersistedSurfaceSchema.parse({}));
}

/** The signal record from its persisted form: entry arrays back into Maps. */
export function loadSurface(
  session: string,
  persisted: PersistedSurface,
): Surface {
  return {
    session,
    selected: persisted.selected,
    drafts: new Map(
      persisted.drafts.map(([id, text]) => [id, { ...EMPTY_DRAFT, text }]),
    ),
    launch: persisted.launch,
    inquiryDrafts: new Map(persisted.inquiryDrafts),
    expanded: new Map(persisted.expanded),
    groups: new Map(
      persisted.groups.map(([id, groups]) => [id, new Map(groups)]),
    ),
    focusedRow: null,
    phase: new Map(persisted.phase),
    scroll: new Map(persisted.scroll),
    drawerOpen: persisted.drawerOpen,
    toolsSheetOpen: false,
    storageHintDismissed: persisted.storageHintDismissed,
    search: '',
    workbench: persisted.workbench,
  };
}

/** The persisted form of a surface: interaction state only, Maps as entries. */
export function persistSurface(surface: Surface): PersistedSurface {
  return {
    selected: surface.selected,
    launch: surface.launch,
    drafts: [...surface.drafts]
      .filter(([, draft]) => draft.text.length > 0)
      .map(([id, draft]) => [id, draft.text]),
    inquiryDrafts: [...surface.inquiryDrafts],
    expanded: [...surface.expanded],
    groups: [...surface.groups].map(([id, groups]) => [id, [...groups]]),
    phase: [...surface.phase],
    scroll: [...surface.scroll],
    drawerOpen: surface.drawerOpen,
    storageHintDismissed: surface.storageHintDismissed,
    workbench: surface.workbench,
  };
}

function retain<V>(
  map: ReadonlyMap<StreamTabId, V>,
  view: SessionView,
): ReadonlyMap<StreamTabId, V> {
  if ([...map.keys()].every((id) => view.streams.has(id))) return map;
  return new Map([...map].filter(([id]) => view.streams.has(id)));
}

/**
 * Every per-stream map drops its entry when that stream leaves the view
 * (PRD 9): an id is never reused, so the entry can never become valid
 * again, and without the prune the maps and the persisted form grow without
 * bound and keep a deleted conversation's draft. Returns the same record
 * when nothing left.
 */
export function pruneSurface(surface: Surface, view: SessionView): Surface {
  const drafts = retain(surface.drafts, view);
  const expanded = retain(surface.expanded, view);
  const groups = retain(surface.groups, view);
  const phase = retain(surface.phase, view);
  const scroll = retain(surface.scroll, view);
  if (
    drafts === surface.drafts &&
    expanded === surface.expanded &&
    groups === surface.groups &&
    phase === surface.phase &&
    scroll === surface.scroll
  ) {
    return surface;
  }
  return { ...surface, drafts, expanded, groups, phase, scroll };
}

/**
 * What a surface shows: `selected` if the view still has that stream, else
 * the first top-level stream, else `null`. The fallback applies only to a
 * non-null id that has disappeared; an explicit `null` is the New-task
 * state and resolves to itself.
 */
export function resolveSelected(
  view: SessionView,
  surface: Surface,
): StreamTabId | null {
  const { selected } = surface;
  if (selected === null) return null;
  if (view.streams.has(selected)) return selected;
  return view.order.at(0) ?? null;
}

/**
 * The phase the run board shows for a stream: the surface's choice while
 * the model still has it, else the current phase (the last opened one, or
 * the first declared), else `null` for a run with no phases.
 */
export function resolvePhase(
  surface: Surface,
  streamId: StreamTabId,
  phases: readonly { readonly key: string; readonly opened: boolean }[],
): string | null {
  const chosen = surface.phase.get(streamId);
  if (chosen !== undefined && phases.some((phase) => phase.key === chosen)) {
    return chosen;
  }
  const opened = phases.findLast((phase) => phase.opened);
  return opened?.key ?? phases.at(0)?.key ?? null;
}

/**
 * Every change a component may ask of the surface. The root applies it;
 * a component never mutates the record. `selectNew` and `toggleDrawer` are
 * also the host-initiated arms of `surface.action` (PRD 8.5).
 */
export type SurfaceAction =
  | { readonly kind: 'select'; readonly streamId: StreamTabId | null }
  | { readonly kind: 'selectNew' }
  | { readonly kind: 'toggleDrawer' }
  | { readonly kind: 'drawer'; readonly open: boolean }
  | { readonly kind: 'toolsSheet'; readonly open: boolean }
  | { readonly kind: 'search'; readonly value: string }
  | {
      readonly kind: 'draft';
      readonly streamId: StreamTabId;
      readonly patch: Partial<Draft>;
    }
  | { readonly kind: 'launch'; readonly patch: LaunchPatch }
  | {
      readonly kind: 'inquiryDraft';
      readonly key: string;
      readonly draft: InquiryDraft | null;
    }
  | {
      readonly kind: 'expand';
      readonly streamId: StreamTabId;
      readonly override: ExpansionOverride;
    }
  | {
      readonly kind: 'group';
      readonly streamId: StreamTabId;
      readonly key: string;
      readonly expanded: boolean;
    }
  | { readonly kind: 'focusRow'; readonly rowId: string | null }
  | {
      readonly kind: 'phase';
      readonly streamId: StreamTabId;
      readonly phase: string;
    }
  | {
      readonly kind: 'scroll';
      readonly streamId: StreamTabId;
      readonly top: number;
    }
  | { readonly kind: 'workbench'; readonly layout: WorkbenchLayout | null }
  | { readonly kind: 'dismissStorageHint' };

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V | null) {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

export function applySurfaceAction(
  surface: Surface,
  action: SurfaceAction,
): Surface {
  switch (action.kind) {
    case 'select':
      return { ...surface, selected: action.streamId, drawerOpen: false };
    case 'selectNew':
      return { ...surface, selected: null, drawerOpen: false };
    case 'toggleDrawer':
      return { ...surface, drawerOpen: !surface.drawerOpen };
    case 'drawer':
      return { ...surface, drawerOpen: action.open };
    case 'toolsSheet':
      return { ...surface, toolsSheetOpen: action.open };
    case 'dismissStorageHint':
      return { ...surface, storageHintDismissed: true };
    case 'search':
      return { ...surface, search: action.value };
    case 'draft':
      return {
        ...surface,
        drafts: withEntry(surface.drafts, action.streamId, {
          ...(surface.drafts.get(action.streamId) ?? EMPTY_DRAFT),
          ...action.patch,
        }),
      };
    case 'launch': {
      const { agent, instruction, ...rest } = action.patch;
      return {
        ...surface,
        launch: {
          ...surface.launch,
          ...rest,
          agent: { ...surface.launch.agent, ...agent },
          instruction: { ...surface.launch.instruction, ...instruction },
        },
      };
    }
    case 'inquiryDraft':
      return {
        ...surface,
        inquiryDrafts: withEntry(
          surface.inquiryDrafts,
          action.key,
          action.draft,
        ),
      };
    case 'expand':
      return {
        ...surface,
        expanded: withEntry(surface.expanded, action.streamId, action.override),
      };
    case 'group':
      return {
        ...surface,
        groups: withEntry(
          surface.groups,
          action.streamId,
          withEntry(
            surface.groups.get(action.streamId) ?? new Map<string, boolean>(),
            action.key,
            action.expanded,
          ),
        ),
      };
    case 'focusRow':
      return { ...surface, focusedRow: action.rowId };
    case 'phase':
      return {
        ...surface,
        phase: withEntry(surface.phase, action.streamId, action.phase),
      };
    case 'scroll':
      return {
        ...surface,
        scroll: withEntry(surface.scroll, action.streamId, action.top),
      };
    case 'workbench':
      return { ...surface, workbench: action.layout };
  }
}
