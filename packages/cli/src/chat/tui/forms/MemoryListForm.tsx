// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Text } from 'ink';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
  runCliMemory,
} from '@cli/runtime/memory';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { MemoryViewItem } from '@shared/schemas';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { AsyncListForm } from './_shared/ListForm';

interface MemoryListFormProps {
  /** The chat entry point's runtime: the memory read runs on it. */
  readonly runtime: ProcessRuntime;
  readonly availableRows?: number;
  readonly onSelect: (storagePath: string) => void;
  readonly onClose: () => void;
}

export function MemoryListForm(props: MemoryListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly MemoryViewItem[], string>
      title="/memory"
      loadingLabel="Loading memories..."
      load={async () =>
        (await runCliMemory(props.runtime, loadMemoryItems())).slice(
          0,
          CLI_MEMORY_LIST_LIMIT,
        )
      }
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
