// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Text } from 'ink';
import { Effect } from 'effect';

import { withSessionFs } from '@texra-ai/harness/host';
import { MemoryStore } from '@texra-ai/harness/plugins';
import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
} from '@cli/runtime/memory';

import { AsyncListForm } from './_shared/ListForm';
import type { MemoryViewItem } from '@texra-ai/harness/schemas';
import { useChatProcess } from '../chatProcess';

interface MemoryListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (storagePath: string) => void;
  readonly onClose: () => void;
}

export function MemoryListForm(props: MemoryListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  return (
    <AsyncListForm<readonly MemoryViewItem[], string>
      title="/memory"
      loadingLabel="Loading memories..."
      load={() =>
        Effect.map(withSessionFs(roots, MemoryStore.list), (items) =>
          items.slice(0, CLI_MEMORY_LIST_LIMIT),
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
