import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acceptEditedFileReplace,
  cleanupStaleDiffFile,
  commitAcceptedFile,
  diffFileLocation,
  type AcceptEditedFileReplacePorts,
  type CommitAcceptedFilePorts,
} from '@latex/acceptedFileTarget';
import type { FileLocation } from '@shared/schemas';
import { createWorkspaceLocation } from '@utils/files/fileLocation';

function absolutePath(...segments: string[]): string {
  return path.join(path.sep, ...segments);
}

/** The canonical base/edited pair most cases below are built on. */
function paperPair(): { base: FileLocation; edited: FileLocation } {
  return {
    base: createWorkspaceLocation(absolutePath('ws', 'paper.tex'), 'paper.tex'),
    edited: createWorkspaceLocation(
      absolutePath('ws', 'paper_correct.tex'),
      'paper_correct.tex',
    ),
  };
}

function recordingDelete(): {
  deleted: FileLocation[];
  deleteFile: (location: FileLocation) => Promise<void>;
} {
  const deleted: FileLocation[] = [];
  return {
    deleted,
    deleteFile: async (location) => {
      deleted.push(location);
    },
  };
}

describe('diffFileLocation', () => {
  it('computes the stale _diff sibling for a base/edited pair', () => {
    const base = createWorkspaceLocation(
      absolutePath('ws', 'chapters', 'paper.tex'),
      'chapters/paper.tex',
    );

    const loc = diffFileLocation(
      base,
      absolutePath('ws', 'chapters', 'paper_correct.tex'),
    );

    expect(loc.kind).toBe('workspace');
    expect(loc.absolutePath).toBe(
      absolutePath('ws', 'chapters', 'paper_correct_diff.tex'),
    );
    if (loc.kind === 'workspace') {
      expect(loc.relativePath).toBe('chapters/paper_correct_diff.tex');
    }
  });
});

describe('cleanupStaleDiffFile', () => {
  it('deletes the derived diff location when it differs from the target', async () => {
    const { base } = paperPair();
    const { deleted, deleteFile } = recordingDelete();

    await cleanupStaleDiffFile(
      base,
      absolutePath('ws', 'paper_correct.tex'),
      base,
      deleteFile,
    );

    expect(deleted.length).toBe(1);
    expect(deleted[0].absolutePath).toBe(
      absolutePath('ws', 'paper_correct_diff.tex'),
    );
  });

  it('skips deletion when the derived diff location is the accept target', async () => {
    const base = createWorkspaceLocation(
      absolutePath('ws', 'paper_diff.tex'),
      'paper_diff.tex',
    );
    const { deleted, deleteFile } = recordingDelete();

    await cleanupStaleDiffFile(
      base,
      absolutePath('ws', 'paper.tex'),
      base,
      deleteFile,
    );

    expect(deleted.length).toBe(0);
  });

  it('skips deletion when the target is not the base itself (copy/sibling write)', async () => {
    const { base } = paperPair();
    const sibling = createWorkspaceLocation(
      absolutePath('ws', 'paper_copy.tex'),
      'paper_copy.tex',
    );
    const { deleted, deleteFile } = recordingDelete();

    await cleanupStaleDiffFile(
      base,
      absolutePath('ws', 'paper_correct.tex'),
      sibling,
      deleteFile,
    );

    expect(deleted.length).toBe(0);
  });
});

describe('acceptEditedFileReplace', () => {
  function buildPorts(
    overrides: Partial<AcceptEditedFileReplacePorts> = {},
  ): AcceptEditedFileReplacePorts & { deleted: FileLocation[] } {
    const { deleted, deleteFile } = recordingDelete();
    return {
      exists: async () => false,
      readFile: async () => 'edited content',
      writeFile: async () => undefined,
      confirm: async () => true,
      emitWritten: () => undefined,
      showInfo: async () => undefined,
      deleteFile,
      deleted,
      ...overrides,
    };
  }

  it('cleans up the stale diff file after a successful accept', async () => {
    const { base, edited } = paperPair();
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    expect(accepted).toBe(true);
    expect(ports.deleted.length).toBe(1);
    expect(ports.deleted[0].absolutePath).toBe(
      absolutePath('ws', 'paper_correct_diff.tex'),
    );
  });

  it('does not clean up when the user declines the confirmation', async () => {
    const { base, edited } = paperPair();
    const ports = buildPorts({ confirm: async () => false });

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    expect(accepted).toBe(false);
    expect(ports.deleted.length).toBe(0);
  });

  it('does not delete the just-accepted file when it collides with the derived diff name', async () => {
    // base is literally named "<edited-stem>_diff.tex" — the same name
    // diffFileLocation would derive for this edited/base pair — so the
    // write target and the "stale diff" coincide.
    const base = createWorkspaceLocation(
      absolutePath('ws', 'paper_diff.tex'),
      'paper_diff.tex',
    );
    const edited = createWorkspaceLocation(
      absolutePath('ws', 'paper.tex'),
      'paper.tex',
    );
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    expect(accepted).toBe(true);
    expect(ports.deleted.length).toBe(0);
  });

  it('does not clean up the base diff when accepting into a new sibling (extension mismatch)', async () => {
    // Different extensions -> getAcceptedFileTarget resolves to a new
    // sibling file, leaving base untouched, so its diff is still accurate.
    const { base } = paperPair();
    const edited = createWorkspaceLocation(
      absolutePath('ws', 'notes.md'),
      'notes.md',
    );
    const ports = buildPorts();

    const accepted = await acceptEditedFileReplace(base, edited, ports);

    expect(accepted).toBe(true);
    expect(ports.deleted.length).toBe(0);
  });
});

describe('commitAcceptedFile', () => {
  function buildCommitPorts(
    overrides: Partial<CommitAcceptedFilePorts> = {},
  ): CommitAcceptedFilePorts & {
    written: Array<{ location: FileLocation; content: string }>;
    infoMessages: string[];
  } {
    const written: Array<{ location: FileLocation; content: string }> = [];
    const infoMessages: string[] = [];
    return {
      readFile: async () => 'edited content',
      writeFile: async (location, content) => {
        written.push({ location, content });
      },
      emitWritten: () => undefined,
      showInfo: async (message) => {
        infoMessages.push(message);
      },
      deleteFile: async () => undefined,
      written,
      infoMessages,
      ...overrides,
    };
  }

  function buildCommitLocations(): {
    base: FileLocation;
    edited: FileLocation;
    copy: FileLocation;
  } {
    return {
      ...paperPair(),
      copy: createWorkspaceLocation(
        absolutePath('ws', 'paper_copy.tex'),
        'paper_copy.tex',
      ),
    };
  }

  it('writes the edited content into the resolved target and reports success', async () => {
    const { base, edited, copy } = buildCommitLocations();
    const ports = buildCommitPorts();

    await commitAcceptedFile(
      base,
      edited,
      { targetLocation: copy, targetFileName: 'paper_copy.tex' },
      false,
      ports,
    );

    expect(ports.written.length).toBe(1);
    expect(ports.written[0].location.absolutePath).toBe(copy.absolutePath);
    expect(ports.written[0].content).toBe('edited content');
    expect(ports.infoMessages.length).toBe(1);
    expect(ports.infoMessages[0]).toMatch(/created/);
  });

  it('reports "replaced" when the caller says the target already existed', async () => {
    const { base, edited } = buildCommitLocations();
    const ports = buildCommitPorts();

    await commitAcceptedFile(
      base,
      edited,
      { targetLocation: base, targetFileName: 'paper.tex' },
      true,
      ports,
    );

    expect(ports.infoMessages[0]).toMatch(/replaced/);
  });

  it('leaves the copy target untouched by diff cleanup (save-as-copy leaves base intact)', async () => {
    const { base, edited, copy } = buildCommitLocations();
    const { deleted, deleteFile } = recordingDelete();
    const ports = buildCommitPorts({ deleteFile });

    await commitAcceptedFile(
      base,
      edited,
      { targetLocation: copy, targetFileName: 'paper_copy.tex' },
      false,
      ports,
    );

    expect(deleted.length).toBe(0);
  });
});
