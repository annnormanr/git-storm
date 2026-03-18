import * as vscode from "vscode";
import * as crypto from "crypto";
import * as path from "path";
import {
  GitService,
  CommitInfo,
  FileDiff,
  DiffHunk,
  DiffLine,
  parseDiffOutput as parseDiffOutputExternal,
} from "../services/gitService";

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function relativeDate(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 365) {
    return `${Math.floor(days / 365)}y ago`;
  }
  if (days > 30) {
    return `${Math.floor(days / 30)}mo ago`;
  }
  if (days > 0) {
    return `${days}d ago`;
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return `${seconds}s ago`;
}

export class FileHistoryProvider implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private panelIsDirectory = new Map<string, boolean>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitService: GitService,
  ) {}

  public async showFileHistory(fileUri: vscode.Uri): Promise<void> {
    const filePath = vscode.workspace.asRelativePath(fileUri, false);
    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal();
      return;
    }

    let isDirectory = false;
    try {
      const stat = await vscode.workspace.fs.stat(fileUri);
      isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      // assume file if stat fails
    }

    const panel = vscode.window.createWebviewPanel(
      "gitstorm.fileHistory",
      `History: ${filePath.split("/").pop() ?? filePath}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.extensionUri],
      },
    );

    this.panels.set(filePath, panel);
    this.panelIsDirectory.set(filePath, isDirectory);

    panel.onDidDispose(
      () => {
        this.panels.delete(filePath);
        this.panelIsDirectory.delete(filePath);
      },
      null,
      this.disposables,
    );

    panel.webview.html = this.getHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          await this.handleMessage(panel, filePath, msg);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`GitStorm: ${message}`);
        }
      },
      null,
      this.disposables,
    );
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    filePath: string,
    msg: { type: string; [key: string]: unknown },
  ): Promise<void> {
    switch (msg.type) {
      case "loadHistory": {
        const filter: {
          author?: string;
          since?: string;
          until?: string;
          search?: string;
        } = {};
        if (msg.author) {
          filter.author = msg.author as string;
        }
        if (msg.since) {
          filter.since = msg.since as string;
        }
        if (msg.until) {
          filter.until = msg.until as string;
        }
        if (msg.search) {
          filter.search = msg.search as string;
        }

        let commits: CommitInfo[];
        if (Object.keys(filter).length > 0) {
          commits = await this.gitService.getLog({
            path: filePath,
            maxCount: 200,
            ...filter,
          });
        } else {
          commits = await this.gitService.getFileHistory(filePath, 200);
        }

        panel.webview.postMessage({
          type: "historyData",
          filePath,
          commits: commits.map((c) => ({
            ...c,
            authorDate: c.authorDate.toISOString(),
            committerDate: c.committerDate.toISOString(),
          })),
        });
        break;
      }
      case "loadDiff": {
        const hash = msg.hash as string;
        const isDir = this.panelIsDirectory.get(filePath) ?? false;
        try {
          const pathArg = isDir ? undefined : filePath;
          const diffs = await this.gitService.getCommitDiff(hash, pathArg);

          if (diffs.length === 0) {
            panel.webview.postMessage({ type: "diffData", hash, diff: null });
          } else if (diffs.length === 1) {
            panel.webview.postMessage({
              type: "diffData",
              hash,
              diff: diffs[0],
            });
          } else {
            const combined = {
              oldPath: "(multiple files)",
              newPath: "(multiple files)",
              status: "M",
              hunks: diffs.flatMap((d) =>
                d.hunks.map((h) => ({
                  ...h,
                  header: `${d.newPath} ${h.header}`,
                })),
              ),
            };
            panel.webview.postMessage({
              type: "diffData",
              hash,
              diff: combined,
            });
          }
        } catch (diffErr: unknown) {
          const errMessage =
            diffErr instanceof Error ? diffErr.message : String(diffErr);
          panel.webview.postMessage({
            type: "diffData",
            hash,
            diff: null,
            error: errMessage,
          });
        }
        break;
      }
      case "diffWithLocal": {
        const hash = msg.hash as string;
        const repoRoot = await this.gitService.getRepoRoot();
        const revUri = vscode.Uri.parse(
          `gitstorm-rev:${filePath.split("/").pop()}`,
        ).with({
          query: JSON.stringify({
            ref: hash,
            filePath: path.resolve(repoRoot, filePath),
          }),
        });
        const localUri = vscode.Uri.joinPath(
          vscode.Uri.file(repoRoot),
          filePath,
        );
        const title = `${filePath} (${hash.substring(0, 7)} ↔ Local)`;
        await vscode.commands.executeCommand(
          "vscode.diff",
          revUri,
          localUri,
          title,
        );
        break;
      }
      case "compareRevisions": {
        const hash1 = msg.hash1 as string;
        const hash2 = msg.hash2 as string;
        const repoRoot = await this.gitService.getRepoRoot();
        const fullPath = path.resolve(repoRoot, filePath);
        const leftUri = vscode.Uri.parse(
          `gitstorm-rev:${filePath.split("/").pop()}`,
        ).with({
          query: JSON.stringify({ ref: hash1, filePath: fullPath }),
        });
        const rightUri = vscode.Uri.parse(
          `gitstorm-rev:${filePath.split("/").pop()}`,
        ).with({
          query: JSON.stringify({ ref: hash2, filePath: fullPath }),
        });
        const title = `${filePath} (${hash1.substring(0, 7)} ↔ ${hash2.substring(0, 7)})`;
        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          rightUri,
          title,
        );
        break;
      }
      case "cherryPick": {
        const hash = msg.hash as string;
        const confirm = await vscode.window.showWarningMessage(
          `Cherry-pick commit ${hash.substring(0, 8)}?`,
          { modal: true },
          "Cherry-Pick",
        );
        if (confirm !== "Cherry-Pick") {
          return;
        }
        const result = await this.gitService.cherryPick(hash);
        vscode.window.showInformationMessage(
          `Cherry-pick: ${result.trim() || hash.substring(0, 8)}`,
        );
        break;
      }
      case "checkoutRevision": {
        const hash = msg.hash as string;
        const confirm = await vscode.window.showWarningMessage(
          `Restore "${filePath}" to revision ${hash.substring(0, 8)}? Current working copy will be overwritten.`,
          { modal: true },
          "Checkout",
        );
        if (confirm !== "Checkout") {
          return;
        }
        const repoRoot = await this.gitService.getRepoRoot();
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        await execFileAsync(
          "git",
          ["--no-pager", "checkout", hash, "--", filePath],
          { cwd: repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        vscode.window.showInformationMessage(
          `"${filePath}" restored to ${hash.substring(0, 8)}`,
        );
        break;
      }
      case "createTag": {
        const hash = msg.hash as string;
        const name = await vscode.window.showInputBox({
          prompt: "Tag name",
          placeHolder: "v1.0.0",
        });
        if (!name) {
          return;
        }
        const tagMsg = await vscode.window.showInputBox({
          prompt: "Tag message (leave empty for lightweight tag)",
        });
        await this.gitService.createTag(
          name.trim(),
          hash,
          tagMsg?.trim() || undefined,
        );
        vscode.window.showInformationMessage(
          `Tag "${name.trim()}" created on ${hash.substring(0, 8)}`,
        );
        break;
      }
      case "createPatch": {
        const hash = msg.hash as string;
        const repoRoot = await this.gitService.getRepoRoot();
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        const { stdout: patch } = await execFileAsync(
          "git",
          [
            "--no-pager",
            "format-patch",
            "-1",
            "--stdout",
            hash,
            "--",
            filePath,
          ],
          {
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
        const saveUri = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(
            `${hash.substring(0, 8)}-${filePath.split("/").pop()}.patch`,
          ),
          filters: { "Patch files": ["patch", "diff"], "All files": ["*"] },
        });
        if (saveUri) {
          const { writeFile } = await import("fs/promises");
          await writeFile(saveUri.fsPath, patch);
          vscode.window.showInformationMessage(
            `Patch saved to ${saveUri.fsPath}`,
          );
        }
        break;
      }
      case "openOnGitHub": {
        const hash = msg.hash as string;
        try {
          const repoRoot = await this.gitService.getRepoRoot();
          const { execFile } = await import("child_process");
          const { promisify } = await import("util");
          const execFileAsync = promisify(execFile);
          const { stdout } = await execFileAsync(
            "git",
            ["--no-pager", "remote", "get-url", "origin"],
            { cwd: repoRoot },
          );
          const url = stdout.trim();
          const sshMatch = url.match(
            /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/,
          );
          const httpsMatch = url.match(
            /github\.com\/([^/]+)\/(.+?)(?:\.git)?$/,
          );
          const match = sshMatch ?? httpsMatch;
          if (match) {
            const ghUrl = `https://github.com/${match[1]}/${match[2]}/commit/${hash}`;
            await vscode.env.openExternal(vscode.Uri.parse(ghUrl));
          } else {
            vscode.window.showWarningMessage(
              "Could not determine GitHub URL from remote.",
            );
          }
        } catch {
          vscode.window.showWarningMessage(
            "Could not determine GitHub URL from remote.",
          );
        }
        break;
      }
      case "goToLog": {
        const hash = msg.hash as string;
        await vscode.commands.executeCommand("gitstorm.goToCommit", hash);
        break;
      }
      case "loadAffectedFiles": {
        const hash = msg.hash as string;
        try {
          const details = await this.gitService.getCommitDetails(hash);
          panel.webview.postMessage({
            type: "affectedFiles",
            hash,
            files: details.files,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({
            type: "affectedFiles",
            hash,
            files: [],
            error: message,
          });
        }
        break;
      }
      case "openFileDiff": {
        const hash = msg.hash as string;
        const diffPath = msg.filePath as string;
        const commit = (await this.gitService.getLog({ maxCount: 1 })).find(
          (c) => c.hash === hash,
        );
        const isRoot = commit && commit.parents.length === 0;
        const parentRef = isRoot
          ? "4b825dc642cb6eb9a060e54bf899d69f82cf7657"
          : `${hash}~1`;
        const left = vscode.Uri.from({
          scheme: "gitstorm-diff",
          path: diffPath,
          query: `ref=${parentRef}`,
        });
        const right = vscode.Uri.from({
          scheme: "gitstorm-diff",
          path: diffPath,
          query: `ref=${hash}`,
        });
        const title = `${diffPath} (${hash.substring(0, 7)})`;
        await vscode.commands.executeCommand("vscode.diff", left, right, title);
        break;
      }
      case "loadFileDiff": {
        const hash = msg.hash as string;
        const diffPath = msg.filePath as string;
        try {
          const diffs = await this.gitService.getCommitDiff(hash, diffPath);
          panel.webview.postMessage({
            type: "diffData",
            hash,
            diff: diffs[0] ?? null,
          });
        } catch (err: unknown) {
          const errMessage = err instanceof Error ? err.message : String(err);
          panel.webview.postMessage({
            type: "diffData",
            hash,
            diff: null,
            error: errMessage,
          });
        }
        break;
      }
      case "copyHash": {
        const hash = msg.hash as string;
        await vscode.env.clipboard.writeText(hash);
        vscode.window.showInformationMessage(
          `Copied ${hash.substring(0, 8)} to clipboard`,
        );
        break;
      }
      case "checkoutFiles": {
        const hash = msg.hash as string;
        const filePaths = msg.filePaths as string[];
        const count = filePaths.length;
        const label =
          count === 1
            ? `Restore "${filePaths[0]}" to revision ${hash.substring(0, 8)}?`
            : `Restore ${count} files to revision ${hash.substring(0, 8)}?`;
        const confirm = await vscode.window.showWarningMessage(
          `${label} Working copy will be overwritten.`,
          { modal: true },
          "Checkout",
        );
        if (confirm !== "Checkout") {
          return;
        }
        const repoRoot = await this.gitService.getRepoRoot();
        const { execFile } = await import("child_process");
        const { promisify } = await import("util");
        const execFileAsync = promisify(execFile);
        await execFileAsync(
          "git",
          ["--no-pager", "checkout", hash, "--", ...filePaths],
          { cwd: repoRoot, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
        );
        const msg2 =
          count === 1
            ? `"${filePaths[0]}" restored to ${hash.substring(0, 8)}`
            : `${count} files restored to ${hash.substring(0, 8)}`;
        vscode.window.showInformationMessage(msg2);
        break;
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex; flex-direction: column; height: 100vh;
    }
    .filter-bar {
      display: flex; gap: 6px; padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      flex-shrink: 0;
    }
    .filter-bar input {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 4px 8px; font-size: 12px; border-radius: 2px; outline: none;
    }
    .filter-bar input:focus { border-color: var(--vscode-focusBorder); }

    .top-half {
      display: flex; flex-shrink: 0; overflow: hidden;
      height: 45%;
      min-height: 120px;
    }
    .commit-panel {
      width: 50%; min-width: 160px; overflow-y: auto; flex-shrink: 0;
    }
    .v-resize-handle {
      width: 5px; cursor: col-resize; flex-shrink: 0;
      background: var(--vscode-panel-border);
    }
    .v-resize-handle:hover, .v-resize-handle.active {
      background: var(--vscode-focusBorder);
    }
    .affected-panel {
      flex: 1; overflow-y: auto;
      border-left: 1px solid var(--vscode-panel-border);
    }
    .affected-files-header {
      padding: 6px 10px; font-size: 11px; font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex; align-items: center; gap: 6px;
      position: sticky; top: 0; z-index: 1;
    }
    .affected-files-header .count {
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      padding: 1px 6px; border-radius: 8px; font-size: 10px;
    }
    .file-item {
      padding: 3px 10px; font-size: 12px; cursor: pointer;
      display: flex; align-items: center; gap: 0;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .file-item:hover { background: var(--vscode-list-hoverBackground); }
    .file-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .file-item.multi-selected { background: var(--vscode-list-inactiveSelectionBackground); }
    .file-item.selected.multi-selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .file-status-badge { font-weight: 700; width: 20px; text-align: center; flex-shrink: 0; }
    .file-status-badge.A { color: #98c379; }
    .file-status-badge.M { color: #61afef; }
    .file-status-badge.D { color: #e06c75; }
    .file-status-badge.R { color: #d19a66; }
    .file-stat-col { width: 40px; text-align: right; flex-shrink: 0; font-size: 11px; padding: 0 2px; }
    .file-stat-col.add { color: #98c379; }
    .file-stat-col.del { color: #e06c75; }
    .file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 8px; font-size: 12px; }
    .file-context-menu {
      position: fixed; background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 4px 0; z-index: 999; min-width: 200px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: none;
    }
    .file-context-menu.visible { display: block; }

    .h-resize-handle {
      height: 5px; cursor: row-resize; flex-shrink: 0;
      background: var(--vscode-panel-border);
    }
    .h-resize-handle:hover, .h-resize-handle.active {
      background: var(--vscode-focusBorder);
    }

    .bottom-half {
      flex: 1; overflow: auto; display: flex; flex-direction: column; min-height: 80px;
    }
    .diff-content { flex: 1; overflow: auto; }

    .commit-item {
      padding: 8px 10px; cursor: pointer;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, transparent);
    }
    .commit-item:hover { background: var(--vscode-list-hoverBackground); }
    .commit-item.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; color: var(--vscode-textLink-foreground);
    }
    .commit-subject { font-size: 13px; margin: 2px 0; font-weight: 500; }
    .commit-meta { font-size: 11px; color: var(--vscode-descriptionForeground); }

    .hint-message {
      display: flex; align-items: center; justify-content: center;
      flex: 1; color: var(--vscode-descriptionForeground); font-size: 13px;
      font-style: italic; padding: 20px; text-align: center;
    }
    .error-message {
      display: flex; align-items: center; justify-content: center;
      flex: 1; color: var(--vscode-errorForeground); font-size: 13px;
      padding: 20px; text-align: center;
    }

    .diff-table { width: 100%; border-collapse: collapse; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; table-layout: fixed; }
    .diff-table td { padding: 0 6px; white-space: pre-wrap; word-break: break-all; vertical-align: top; }
    .diff-table .line-num {
      width: 36px; text-align: right; color: var(--vscode-editorLineNumber-foreground);
      user-select: none; padding-right: 4px;
    }
    .diff-table .hunk-header { background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,120,215,0.1)); color: var(--vscode-descriptionForeground); font-style: italic; padding: 2px 6px; }
    .diff-table .old-side { width: 50%; border-right: 1px solid var(--vscode-panel-border); }
    .diff-table .new-side { width: 50%; }
    .diff-table td.add-bg { background: var(--vscode-diffEditor-insertedLineBackground, rgba(35,134,54,0.15)); }
    .diff-table td.del-bg { background: var(--vscode-diffEditor-removedLineBackground, rgba(218,54,51,0.15)); }
    .diff-table td.empty-bg { background: var(--vscode-editor-background); opacity: 0.5; }
    .loading { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
    .context-menu {
      position: fixed; background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 4px 0; z-index: 999; min-width: 200px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3); display: none;
    }
    .context-menu.visible { display: block; }
    .context-menu-item {
      padding: 4px 12px; cursor: pointer; font-size: 12px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
    }
    .context-menu-item:hover {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
    }
    .context-menu-sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 4px 0; }
  </style>
</head>
<body>
  <div class="filter-bar">
    <input id="authorFilter" type="text" placeholder="Author..." />
    <input id="sinceFilter" type="date" title="Since" />
    <input id="untilFilter" type="date" title="Until" />
    <input id="searchFilter" type="text" placeholder="Search messages..." />
  </div>
  <div class="top-half" id="topHalf">
    <div class="commit-panel" id="commitPanel">
      <div class="loading">Loading history...</div>
    </div>
    <div class="v-resize-handle" id="vResizeHandle"></div>
    <div class="affected-panel" id="affectedPanel">
      <div class="hint-message">Select a commit to view changes</div>
    </div>
  </div>
  <div class="h-resize-handle" id="hResizeHandle"></div>
  <div class="bottom-half" id="bottomHalf">
    <div class="diff-content" id="diffContent">
      <div class="hint-message">Select a commit to view the diff</div>
    </div>
  </div>
  <div class="context-menu" id="contextMenu"></div>
  <div class="file-context-menu" id="fileContextMenu"></div>

  <script nonce="${nonce}">
    var vscodeApi = acquireVsCodeApi();
    var commits = [];
    var selectedHash = null;
    var selectedFilePath = null;
    var selectedFilePaths = [];
    var contextHash = null;
    var compareHash = null;
    var currentAffectedFiles = [];
    var fileContextHash = null;
    var fileContextPaths = [];

    var commitPanel = document.getElementById('commitPanel');
    var diffContent = document.getElementById('diffContent');
    var affectedPanel = document.getElementById('affectedPanel');
    var contextMenu = document.getElementById('contextMenu');
    var fileContextMenu = document.getElementById('fileContextMenu');

    function escapeHtml(s) {
      var d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function relDate(iso) {
      var d = new Date(iso);
      var diff = Date.now() - d.getTime();
      var s = Math.floor(diff/1000), m = Math.floor(s/60), h = Math.floor(m/60), days = Math.floor(h/24);
      if (days > 365) return Math.floor(days/365) + 'y ago';
      if (days > 30) return Math.floor(days/30) + 'mo ago';
      if (days > 0) return days + 'd ago';
      if (h > 0) return h + 'h ago';
      if (m > 0) return m + 'm ago';
      return 'just now';
    }

    function renderCommits() {
      var html = '';
      for (var i = 0; i < commits.length; i++) {
        var c = commits[i];
        var sel = c.hash === selectedHash ? ' selected' : '';
        html += '<div class="commit-item' + sel + '" data-hash="' + c.hash + '">';
        html += '<div class="commit-hash">' + escapeHtml(c.abbreviatedHash) + '</div>';
        html += '<div class="commit-subject">' + escapeHtml(c.subject) + '</div>';
        html += '<div class="commit-meta">' + escapeHtml(c.author) + ' - ' + relDate(c.authorDate) + '</div>';
        html += '</div>';
      }
      if (commits.length === 0) {
        html = '<div class="loading">No commits found</div>';
      }
      commitPanel.innerHTML = html;
    }

    function renderAffectedFiles(hash, files, error) {
      if (error) {
        affectedPanel.innerHTML = '<div class="error-message">Error: ' + escapeHtml(error) + '</div>';
        currentAffectedFiles = [];
        return;
      }
      if (!files || files.length === 0) {
        affectedPanel.innerHTML = '<div class="hint-message">No affected files for this commit</div>';
        currentAffectedFiles = [];
        return;
      }
      currentAffectedFiles = files;
      var html = '<div class="affected-files-header">Affected Files <span class="count">' + files.length + '</span></div>';
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        var selClass = f.path === selectedFilePath ? ' selected' : '';
        var multiClass = selectedFilePaths.indexOf(f.path) !== -1 ? ' multi-selected' : '';
        html += '<div class="file-item' + selClass + multiClass + '" data-hash="' + escapeHtml(hash) + '" data-path="' + escapeHtml(f.path) + '">';
        html += '<span class="file-status-badge ' + f.status + '">' + f.status + '</span>';
        html += '<span class="file-stat-col add">+' + f.additions + '</span>';
        html += '<span class="file-stat-col del">-' + f.deletions + '</span>';
        html += '<span class="file-path" title="' + escapeHtml(f.path) + '">' + escapeHtml(f.path) + '</span>';
        html += '</div>';
      }
      affectedPanel.innerHTML = html;
    }

    function highlightSelectedFile() {
      var items = affectedPanel.querySelectorAll('.file-item');
      for (var i = 0; i < items.length; i++) {
        var p = items[i].dataset.path;
        if (p === selectedFilePath) {
          items[i].classList.add('selected');
        } else {
          items[i].classList.remove('selected');
        }
        if (selectedFilePaths.indexOf(p) !== -1) {
          items[i].classList.add('multi-selected');
        } else {
          items[i].classList.remove('multi-selected');
        }
      }
    }

    function selectAffectedFile(hash, filePath) {
      selectedFilePath = filePath;
      highlightSelectedFile();
      diffContent.innerHTML = '<div class="loading">Loading diff for ' + escapeHtml(filePath) + '...</div>';
      vscodeApi.postMessage({ type: 'loadFileDiff', hash: hash, filePath: filePath });
    }

    function renderDiff(diff) {
      if (!diff || !diff.hunks || diff.hunks.length === 0) {
        diffContent.innerHTML = '<div class="hint-message">No changes in this file for this commit</div>';
        return;
      }
      var html = '<table class="diff-table"><colgroup><col style="width:36px"><col style="width:calc(50% - 36px)"><col style="width:36px"><col style="width:calc(50% - 36px)"></colgroup>';
      for (var hi = 0; hi < diff.hunks.length; hi++) {
        var hunk = diff.hunks[hi];
        html += '<tr><td colspan="4" class="hunk-header">@@ -' + hunk.oldStart + ',' + hunk.oldLines + ' +' + hunk.newStart + ',' + hunk.newLines + ' @@ ' + escapeHtml(hunk.header) + '</td></tr>';
        var lines = hunk.lines;
        var idx = 0;
        while (idx < lines.length) {
          var line = lines[idx];
          if (line.type === 'context') {
            html += '<tr>';
            html += '<td class="line-num">' + (line.oldLineNumber != null ? line.oldLineNumber : '') + '</td>';
            html += '<td class="old-side">' + escapeHtml(line.content) + '</td>';
            html += '<td class="line-num">' + (line.newLineNumber != null ? line.newLineNumber : '') + '</td>';
            html += '<td class="new-side">' + escapeHtml(line.content) + '</td>';
            html += '</tr>';
            idx++;
          } else {
            var deletes = [];
            var adds = [];
            while (idx < lines.length && lines[idx].type === 'delete') { deletes.push(lines[idx]); idx++; }
            while (idx < lines.length && lines[idx].type === 'add') { adds.push(lines[idx]); idx++; }
            var maxLen = Math.max(deletes.length, adds.length);
            for (var j = 0; j < maxLen; j++) {
              html += '<tr>';
              if (j < deletes.length) {
                html += '<td class="line-num del-bg">' + (deletes[j].oldLineNumber != null ? deletes[j].oldLineNumber : '') + '</td>';
                html += '<td class="old-side del-bg">' + escapeHtml(deletes[j].content) + '</td>';
              } else {
                html += '<td class="line-num empty-bg"></td><td class="old-side empty-bg"></td>';
              }
              if (j < adds.length) {
                html += '<td class="line-num add-bg">' + (adds[j].newLineNumber != null ? adds[j].newLineNumber : '') + '</td>';
                html += '<td class="new-side add-bg">' + escapeHtml(adds[j].content) + '</td>';
              } else {
                html += '<td class="line-num empty-bg"></td><td class="new-side empty-bg"></td>';
              }
              html += '</tr>';
            }
          }
        }
      }
      html += '</table>';
      diffContent.innerHTML = html;
    }

    commitPanel.addEventListener('click', function(e) {
      var item = e.target.closest('.commit-item');
      if (!item) return;
      selectedHash = item.dataset.hash;
      selectedFilePath = null;
      selectedFilePaths = [];
      currentAffectedFiles = [];
      renderCommits();
      affectedPanel.innerHTML = '<div class="loading">Loading affected files...</div>';
      diffContent.innerHTML = '<div class="hint-message">Loading...</div>';
      vscodeApi.postMessage({ type: 'loadAffectedFiles', hash: selectedHash });
    });

    commitPanel.addEventListener('contextmenu', function(e) {
      var item = e.target.closest('.commit-item');
      if (!item) return;
      e.preventDefault();
      contextHash = item.dataset.hash;
      showContextMenu(e.clientX, e.clientY);
    });

    function showContextMenu(x, y) {
      var compareLabel = compareHash
        ? 'Compare with ' + compareHash.substring(0, 7) + '...'
        : 'Compare with...';
      contextMenu.innerHTML = [
        '<div class="context-menu-item" data-action="showDiff">Show Diff</div>',
        '<div class="context-menu-item" data-action="diffWithLocal">Show Diff with Local</div>',
        '<div class="context-menu-sep"></div>',
        compareHash
          ? '<div class="context-menu-item" data-action="compareWith">' + escapeHtml(compareLabel) + '</div>'
          : '<div class="context-menu-item" data-action="markForCompare">Select for Compare</div>',
        compareHash ? '<div class="context-menu-item" data-action="clearCompare">Clear Compare Selection</div>' : '',
        '<div class="context-menu-sep"></div>',
        '<div class="context-menu-item" data-action="cherryPick">Cherry-Pick</div>',
        '<div class="context-menu-item" data-action="checkoutRevision">Checkout This Revision</div>',
        '<div class="context-menu-sep"></div>',
        '<div class="context-menu-item" data-action="createTag">Create Tag...</div>',
        '<div class="context-menu-item" data-action="createPatch">Create Patch...</div>',
        '<div class="context-menu-sep"></div>',
        '<div class="context-menu-item" data-action="openOnGitHub">Open on GitHub</div>',
        '<div class="context-menu-item" data-action="goToLog">Go to Commit in Log</div>',
        '<div class="context-menu-sep"></div>',
        '<div class="context-menu-item" data-action="copyHash">Copy Commit Hash</div>',
      ].join('');
      contextMenu.style.left = x + 'px';
      contextMenu.style.top = y + 'px';
      contextMenu.classList.add('visible');
    }

    document.addEventListener('click', function() {
      contextMenu.classList.remove('visible');
      fileContextMenu.classList.remove('visible');
    });

    contextMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.context-menu-item');
      if (!item || !contextHash) return;
      var action = item.dataset.action;
      switch (action) {
        case 'showDiff':
          selectedHash = contextHash;
          selectedFilePath = null;
          selectedFilePaths = [];
          currentAffectedFiles = [];
          renderCommits();
          affectedPanel.innerHTML = '<div class="loading">Loading affected files...</div>';
          diffContent.innerHTML = '<div class="hint-message">Loading...</div>';
          vscodeApi.postMessage({ type: 'loadAffectedFiles', hash: contextHash });
          break;
        case 'diffWithLocal':
          vscodeApi.postMessage({ type: 'diffWithLocal', hash: contextHash });
          break;
        case 'markForCompare':
          compareHash = contextHash;
          break;
        case 'compareWith':
          if (compareHash && compareHash !== contextHash) {
            vscodeApi.postMessage({ type: 'compareRevisions', hash1: compareHash, hash2: contextHash });
            compareHash = null;
          }
          break;
        case 'clearCompare':
          compareHash = null;
          break;
        case 'cherryPick':
          vscodeApi.postMessage({ type: 'cherryPick', hash: contextHash });
          break;
        case 'checkoutRevision':
          vscodeApi.postMessage({ type: 'checkoutRevision', hash: contextHash });
          break;
        case 'createTag':
          vscodeApi.postMessage({ type: 'createTag', hash: contextHash });
          break;
        case 'createPatch':
          vscodeApi.postMessage({ type: 'createPatch', hash: contextHash });
          break;
        case 'openOnGitHub':
          vscodeApi.postMessage({ type: 'openOnGitHub', hash: contextHash });
          break;
        case 'goToLog':
          vscodeApi.postMessage({ type: 'goToLog', hash: contextHash });
          break;
        case 'copyHash':
          vscodeApi.postMessage({ type: 'copyHash', hash: contextHash });
          break;
      }
      contextMenu.classList.remove('visible');
    });

    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'historyData') {
        commits = msg.commits;
        renderCommits();
        if (commits.length > 0 && !selectedHash) {
          selectedHash = commits[0].hash;
          renderCommits();
          affectedPanel.innerHTML = '<div class="loading">Loading affected files...</div>';
          diffContent.innerHTML = '<div class="hint-message">Loading...</div>';
          vscodeApi.postMessage({ type: 'loadAffectedFiles', hash: selectedHash });
        }
      } else if (msg.type === 'diffData') {
        if (msg.error) {
          diffContent.innerHTML = '<div class="error-message">Error loading diff: ' + escapeHtml(msg.error) + '</div>';
        } else {
          renderDiff(msg.diff);
        }
      } else if (msg.type === 'affectedFiles') {
        renderAffectedFiles(msg.hash, msg.files, msg.error);
        if (!msg.error && msg.files && msg.files.length > 0) {
          selectedFilePaths = [msg.files[0].path];
          selectAffectedFile(msg.hash, msg.files[0].path);
        } else if (!msg.error) {
          diffContent.innerHTML = '<div class="hint-message">No files changed in this commit</div>';
        }
      }
    });

    affectedPanel.addEventListener('click', function(e) {
      var item = e.target.closest('.file-item');
      if (!item) return;
      var hash = item.dataset.hash;
      var filePath = item.dataset.path;

      if (e.ctrlKey || e.metaKey) {
        var idx = selectedFilePaths.indexOf(filePath);
        if (idx !== -1) {
          selectedFilePaths.splice(idx, 1);
        } else {
          selectedFilePaths.push(filePath);
        }
        selectAffectedFile(hash, filePath);
      } else if (e.shiftKey && selectedFilePath) {
        var allItems = affectedPanel.querySelectorAll('.file-item');
        var anchorIdx = -1, targetIdx = -1;
        for (var i = 0; i < allItems.length; i++) {
          if (allItems[i].dataset.path === selectedFilePath) anchorIdx = i;
          if (allItems[i].dataset.path === filePath) targetIdx = i;
        }
        if (anchorIdx !== -1 && targetIdx !== -1) {
          var lo = Math.min(anchorIdx, targetIdx);
          var hi = Math.max(anchorIdx, targetIdx);
          selectedFilePaths = [];
          for (var j = lo; j <= hi; j++) {
            selectedFilePaths.push(allItems[j].dataset.path);
          }
        }
        selectAffectedFile(hash, filePath);
      } else {
        selectedFilePaths = [filePath];
        selectAffectedFile(hash, filePath);
      }
    });

    affectedPanel.addEventListener('contextmenu', function(e) {
      var item = e.target.closest('.file-item');
      if (!item) return;
      e.preventDefault();
      var hash = item.dataset.hash;
      var filePath = item.dataset.path;
      if (selectedFilePaths.indexOf(filePath) === -1) {
        selectedFilePaths = [filePath];
        selectedFilePath = filePath;
        highlightSelectedFile();
      }
      fileContextHash = hash;
      fileContextPaths = selectedFilePaths.slice();
      var count = fileContextPaths.length;
      var label = count === 1 ? 'Checkout this file at this revision' : 'Checkout ' + count + ' files at this revision';
      fileContextMenu.innerHTML = '<div class="context-menu-item" data-action="checkoutFiles">' + escapeHtml(label) + '</div>';
      fileContextMenu.style.left = e.clientX + 'px';
      fileContextMenu.style.top = e.clientY + 'px';
      fileContextMenu.classList.add('visible');
    });

    fileContextMenu.addEventListener('click', function(e) {
      var item = e.target.closest('.context-menu-item');
      if (!item) return;
      if (item.dataset.action === 'checkoutFiles' && fileContextHash && fileContextPaths.length > 0) {
        vscodeApi.postMessage({ type: 'checkoutFiles', hash: fileContextHash, filePaths: fileContextPaths });
      }
      fileContextMenu.classList.remove('visible');
    });

    var filterTimer = null;
    function emitFilter() {
      vscodeApi.postMessage({
        type: 'loadHistory',
        author: document.getElementById('authorFilter').value || undefined,
        since: document.getElementById('sinceFilter').value || undefined,
        until: document.getElementById('untilFilter').value || undefined,
        search: document.getElementById('searchFilter').value || undefined,
      });
    }
    var filterIds = ['authorFilter', 'sinceFilter', 'untilFilter', 'searchFilter'];
    for (var fi = 0; fi < filterIds.length; fi++) {
      document.getElementById(filterIds[fi]).addEventListener('input', function() {
        clearTimeout(filterTimer);
        filterTimer = setTimeout(emitFilter, 400);
      });
    }

    vscodeApi.postMessage({ type: 'loadHistory' });

    // Vertical resize (between commit list and affected files)
    (function() {
      var handle = document.getElementById('vResizeHandle');
      var panel = document.getElementById('commitPanel');
      var dragging = false;
      var startX = 0;
      var startWidth = 0;

      handle.addEventListener('mousedown', function(e) {
        dragging = true;
        startX = e.clientX;
        startWidth = panel.offsetWidth;
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        var newWidth = startWidth + (e.clientX - startX);
        if (newWidth < 160) newWidth = 160;
        if (newWidth > window.innerWidth - 200) newWidth = window.innerWidth - 200;
        panel.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', function() {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    })();

    // Horizontal resize (between top half and bottom half)
    (function() {
      var handle = document.getElementById('hResizeHandle');
      var topHalf = document.getElementById('topHalf');
      var dragging = false;
      var startY = 0;
      var startHeight = 0;

      handle.addEventListener('mousedown', function(e) {
        dragging = true;
        startY = e.clientY;
        startHeight = topHalf.offsetHeight;
        handle.classList.add('active');
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', function(e) {
        if (!dragging) return;
        var newHeight = startHeight + (e.clientY - startY);
        if (newHeight < 120) newHeight = 120;
        if (newHeight > window.innerHeight - 150) newHeight = window.innerHeight - 150;
        topHalf.style.height = newHeight + 'px';
      });

      document.addEventListener('mouseup', function() {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    })();
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.panelIsDirectory.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
