// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Text } from 'ink';
import { Effect } from 'effect';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
  runCliMemory,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/tools/memoryView';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { AsyncListForm } from './_shared/ListForm';
import type { ProcessRuntime } from '@texra-ai/harness';
import type { WorkspaceRoots } from '@texra-ai/harness';

interface MemoryListFormProps {
  /** The process runtime the listing runs on, from the surface that
   *  registered this form. */
  readonly runtime: ProcessRuntime;
  /** The roots the listing's storage view is built from. */
  readonly roots: Pick<
    WorkspaceRoots,
    'workspace' | 'storage' | 'globalStorage'
  >;
  readonly availableRows?: number;
  readonly onSelect: (storagePath: string) => void;
  readonly onClose: () => void;
}

export function MemoryListForm(props: MemoryListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly MemoryViewItem[], string>
      title="/memory"
      loadingLabel="Loading memories..."
      load={() =>
        Effect.map(runCliMemory(props.roots, loadMemoryItems()), (items) =>
          items.slice(0, CLI_MEMORY_LIST_LIMIT),
        )
      }
      runtime={props.runtime}
      items={(entries) =>
        entries.map((item) => ({
          value: item.storagePath,
          label: item.displayPath,
          description: cliMemoryItemDescription(item),
        }))
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor>Choose a memory to preview. Press Esc to close.</Text>
      }
      emptyMessage="No memories yet. Ask TeXRA to remember something and it will appear here."
      selectMarginTop={1}
      action="preview"
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
