# Proposed Task ID and Storage Updates

To simplify output management and hide some complexity from users, TeXRA should store generated XML files and packed outputs inside **workspace storage** rather than directly within the workspace. Each task would be assigned a unique ID which is reused across the XML filenames, stored logs, and packaged archives.

## Key ideas

- **Unique Task IDs**: derive an ID when an agent starts (e.g. `agent@model:basename`). This ID becomes the directory name under workspace storage. All round files and logs use this prefix so they are easy to find programmatically.
- **XML in Storage**: write XML responses to `storage://tasks/<ID>/` using `workspaceStorageUtils` instead of writing to the workspace root. This keeps the project folder clean.
- **Packing Workflow**: the existing `pack` command should save files inside the same `storage://tasks/<ID>/` directory instead of using a separate `packs` folder. The ProgressBoard and History view would still offer buttons to open this folder.
- **Repairing Missing Results**: the History view should also surface a button that opens the raw XML in the editor so users can manually fix incomplete output.

All agents adopt this storage approach by default; there is no opt-out setting.

By consolidating task data inside workspace storage, TeXRA can better manage cleanup, avoid cluttering user projects, and provide a consistent place to retrieve past results.
