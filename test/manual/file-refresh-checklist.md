# File Refresh Icon QA Checklist

Use this checklist after building the webview bundle to confirm the refresh icons repopulate their dropdowns correctly.

1. **Input files (codicon-file-code)**
   - Open a workspace with at least one `.tex` file.
   - Remove the file from the input dropdown, then click the input refresh icon.
   - Confirm the input dropdown repopulates with available LaTeX files.
   - Repeat after renaming or deleting the file and ensure the info toast explains why nothing changed when no files are available.
2. **Reference files (codicon-book)**
   - Add a `.tex` or `.pdf` example file to the workspace and click the reference refresh icon.
   - Verify the reference dropdown updates with the new file.
   - Temporarily move the reference file out of the workspace, click refresh again, and confirm the empty-state toast appears.
3. **Auxiliary files (codicon-file-add)**
   - Place a `.cls` or `.sty` file in the workspace and refresh auxiliary files.
   - Confirm the dropdown contains the auxiliary asset.
   - Remove the auxiliary asset and refresh to confirm the informational toast explains the empty result.
4. **Media files (codicon-file-media)**
   - Add an image (e.g., `.png`) to the workspace and refresh media files.
   - Ensure the media dropdown lists the new asset.
   - Remove or rename the asset and refresh to check for the empty-state toast.
5. **Base/Edited files (codicon-edit)**
   - Select a base file, then click the edited refresh icon.
   - Confirm the base selector stays populated and the edited dropdown shows files that match the selected base.
   - Clear the base selection and click refresh again; verify the toast instructs you to choose a base file.
6. **Git commits (codicon-git-commit)**
   - Open a Git workspace and click the commit refresh icon.
   - Ensure the commit dropdown repopulates with recent commits.
   - Open a non-Git workspace and click refresh to confirm the toast clarifies that no commits were found.

Document any discrepancies before shipping.
