## MainView Manual Test Checklist

### State Persistence

- [ ] Set all form fields, close/reopen VS Code → fields restored
- [ ] Switch session type (workflow ↔ tool-use) → correct agent shown
- [ ] Add multiple files to lists → lists restored after reload
- [ ] Toggle visibility on file lists → visibility preserved

### State Restore (Cross-webview)

- [ ] From HistoryView: click "Restore" → MainView populated correctly
- [ ] From ProgressView: click "Setup Followup" → MainView populated correctly

### Component Interactions

- [ ] File dropdowns: select file → field updates
- [ ] Checkboxes: toggle → state saves
- [ ] Banners: API key missing → banner shows, add key → banner hides
- [ ] Execute button: click → progress view opens
