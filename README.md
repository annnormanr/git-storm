# GitStorm

**WebStorm-level Git tooling for VS Code.** Full commit graph, file history, blame, changelists, shelve/unshelve, branch management, merge conflict resolution, and GitHub PR integration — all in one extension.

## Features

### Git Log Panel

- Full commit history with **branch/merge graph visualization** (SVG with colored lanes)
- Filter by **branch, author, date range, file path, or commit message text**
- Click any commit to see its details, changed files, and line-level stats
- **Infinite scroll** — loads more commits as you scroll down
- Right-click context menu: cherry-pick, revert, reset, tag, copy hash

### File History

- View the **complete commit history** for any file (follows renames)
- Side-by-side **inline diff viewer** — click a commit to see what changed
- Filter by author, date range, or message search
- **Full right-click context menu** (WebStorm parity):
  - Show Diff (vs parent commit)
  - Show Diff with Local (vs working copy)
  - Select for Compare / Compare with... (diff any two revisions)
  - Cherry-Pick commit
  - Checkout This Revision (restore file to a specific commit)
  - Create Tag...
  - Create Patch... (export as `.patch` file)
  - Open on GitHub
  - Go to Commit in Log
  - Copy Commit Hash

### Blame / Annotate

- **Inline blame**: shows author, date, and commit message at the end of the current line
- **Gutter annotations**: full blame info for every line with hover details
- Toggle on/off with keyboard shortcuts or right-click menu
- Caches blame data per file, invalidates on save

### Changelists

- **WebStorm-style changelist groups** — organize changed files into named sets
- **Drag and drop** files between changelists in the tree view
- Create, rename, delete changelists; set a default
- Commit all files in a changelist at once

### Shelve / Unshelve

- **Per-file patch-based shelving** (more granular than `git stash`)
- Shelve captures diffs, then reverts the working tree
- Unshelve applies stored patches back
- Persisted in workspace state — survives VS Code restarts

### Partial Commits

- Select lines in the editor, right-click → **"Commit Selected Lines/Hunks"**
- Generates a patch for just the selected range, stages it, and commits

### Branch Management

- **Tree view** with local/remote grouping, ahead/behind indicators
- Create, checkout, delete (with force option), merge (ff/no-ff), rebase
- **Compare branches** — see all changed files, click to view per-file diff
- **Interactive rebase** — opens a terminal with `git rebase -i`

### Merge Conflict Resolution

- **Three-way merge tool** in a webview panel
- Four panes: Base (common ancestor), Ours, Theirs, and an editable Result
- Accept ours, accept theirs, accept both, or manually edit
- Navigate between multiple conflicting files
- Abort merge button

### Stash Management

- **Tree view** with expandable stash entries showing individual files
- Stash with optional message and untracked file inclusion
- Pop, apply, or drop from quick pick or tree view
- View stash diffs

### GitHub Integration

- **Pull Request list** in the sidebar — filter by open/closed/all
- **Create PRs** with title, description, base branch picker, draft option
- **PR detail view** with full conversation (comments + reviews), labels, stats
- **Submit reviews**: approve, request changes, or comment
- **Merge PRs** with merge/squash/rebase method selection
- **Create gists** from selection or entire file (public or secret)
- Token resolution: VS Code settings → `gh` CLI → manual prompt

## Installation

### From Source (local install)

```bash
# 1. Clone and build
cd GitStorm
npm install
npm run compile

# 2. Package into a .vsix
npm install -g @vscode/vsce
vsce package

# 3. Install the extension
code --install-extension gitstorm-0.1.0.vsix
```

Then reload VS Code and open any folder containing a `.git` directory.

### Development / Testing

```bash
cd GitStorm
npm install
npm run watch    # rebuilds on file changes

# Press F5 in VS Code to launch the Extension Development Host
# Or use the CLI:
code --extensionDevelopmentPath="$(pwd)" /path/to/any/git/repo
```

## Keyboard Shortcuts

| Shortcut         | Command             |
| ---------------- | ------------------- |
| `Ctrl+Shift+G L` | Show Git Log        |
| `Ctrl+Shift+G H` | Show File History   |
| `Ctrl+Shift+G A` | Annotate (Blame)    |
| `Ctrl+Shift+G B` | Toggle Inline Blame |

## Sidebar Views

When activated, GitStorm adds an activity bar icon with five views:

1. **Git Log** — Webview with commit graph and filtering
2. **Branches** — Tree view with local/remote branches
3. **Stashes** — Tree view with stash entries and files
4. **Changelists** — Tree view with drag-and-drop file grouping
5. **Pull Requests** — Webview with GitHub PR list

## Right-Click Context Menus

### File Explorer & Editor

- Show File History
- Annotate (Blame)
- Compare with Branch...
- Compare with Revision...
- Show Diff
- Rollback File
- Commit Selected Lines/Hunks (editor only, when text is selected)

### File History View (right-click a commit)

- Show Diff / Show Diff with Local
- Select for Compare / Compare with...
- Cherry-Pick
- Checkout This Revision
- Create Tag...
- Create Patch...
- Open on GitHub
- Go to Commit in Log
- Copy Commit Hash

### Git Log Panel (right-click a commit)

- Cherry-Pick
- Revert
- Reset (soft / mixed / hard)
- Create Tag...
- Copy Commit Hash

## Configuration

| Setting                      | Default      | Description                                                 |
| ---------------------------- | ------------ | ----------------------------------------------------------- |
| `gitstorm.maxLogEntries`     | `5000`       | Maximum log entries to load                                 |
| `gitstorm.showInlineBlame`   | `true`       | Show inline blame at end of current line                    |
| `gitstorm.dateFormat`        | `"relative"` | Date format: `relative`, `absolute`, or `iso`               |
| `gitstorm.github.token`      | `""`         | GitHub personal access token (or use `gh` CLI auth)         |
| `gitstorm.graph.style`       | `"curved"`   | Commit graph line style: `curved`, `angular`, or `straight` |
| `gitstorm.defaultChangelist` | `"Default"`  | Name of the default changelist                              |

## Architecture

```
GitStorm/
├── src/
│   ├── extension.ts              # Entry point — wires everything together
│   ├── services/
│   │   ├── gitService.ts         # Git CLI wrapper (all git operations)
│   │   ├── graphBuilder.ts       # Commit graph lane layout algorithm
│   │   ├── changelistManager.ts  # Changelist persistence & management
│   │   ├── shelveManager.ts      # Shelve/unshelve via patches
│   │   └── githubService.ts      # GitHub REST API client
│   ├── providers/
│   │   ├── logViewProvider.ts    # Git log webview with graph
│   │   ├── blameProvider.ts      # Inline blame & gutter annotations
│   │   ├── branchTreeProvider.ts # Branch tree view
│   │   ├── stashTreeProvider.ts  # Stash tree view
│   │   ├── changelistTreeProvider.ts  # Changelist tree with drag-drop
│   │   ├── fileHistoryProvider.ts     # File history webview
│   │   ├── mergeConflictProvider.ts   # Three-way merge webview
│   │   └── prViewProvider.ts     # GitHub PR list & detail webviews
│   └── commands/
│       ├── branchCommands.ts     # Branch CRUD, compare, interactive rebase
│       ├── fileCommands.ts       # History, blame, diff, rollback, partial commit
│       ├── logCommands.ts        # Cherry-pick, revert, reset, tag, copy hash
│       ├── mergeCommands.ts      # Conflict resolution, abort/continue merge/rebase
│       ├── stashCommands.ts      # Stash push/pop/apply/drop
│       ├── changelistCommands.ts # Create changelist, move files, shelve/unshelve
│       └── githubCommands.ts     # Create/view/review PRs, create gists
├── package.json
├── tsconfig.json
├── webpack.config.js
├── LICENSE
└── README.md
```

## Requirements

- VS Code 1.85.0+
- Git installed and available on `PATH`
- For GitHub features: `gh` CLI authenticated, or a personal access token

## License

MIT
