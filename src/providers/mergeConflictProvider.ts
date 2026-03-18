import * as vscode from "vscode";
import * as crypto from "crypto";
import { GitService, MergeConflict } from "../services/gitService";

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

export class MergeConflictProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private conflicts: MergeConflict[] = [];
  private currentIndex = 0;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitService: GitService,
  ) {}

  public async show(): Promise<void> {
    this.conflicts = await this.gitService.getMergeConflicts();
    if (this.conflicts.length === 0) {
      vscode.window.showInformationMessage("No merge conflicts detected");
      return;
    }

    this.currentIndex = 0;
    this.showPanel();
  }

  public async openMergeTool(conflict: MergeConflict): Promise<void> {
    this.conflicts = await this.gitService.getMergeConflicts();
    const idx = this.conflicts.findIndex((c) => c.path === conflict.path);
    this.currentIndex = idx >= 0 ? idx : 0;

    if (this.conflicts.length === 0) {
      this.conflicts = [conflict];
      this.currentIndex = 0;
    }

    this.showPanel();
  }

  private showPanel(): void {
    if (this.panel) {
      this.panel.reveal();
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "gitstorm.mergeConflict",
        "Merge Conflict Resolution",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        },
      );

      this.panel.onDidDispose(
        () => {
          this.panel = undefined;
        },
        null,
        this.disposables,
      );

      this.panel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
            await this.handleMessage(msg);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`GitStorm: ${message}`);
          }
        },
        null,
        this.disposables,
      );
    }

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.sendConflictData();
  }

  private sendConflictData(): void {
    if (!this.panel || this.conflicts.length === 0) {
      return;
    }

    const conflict = this.conflicts[this.currentIndex];
    this.panel.webview.postMessage({
      type: "conflictData",
      conflict: {
        path: conflict.path,
        ours: conflict.ours,
        theirs: conflict.theirs,
        base: conflict.base,
      },
      currentIndex: this.currentIndex,
      totalConflicts: this.conflicts.length,
    });
  }

  private async handleMessage(msg: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (msg.type) {
      case "loadConflict":
        this.sendConflictData();
        break;

      case "resolveOurs": {
        const conflict = this.conflicts[this.currentIndex];
        await this.gitService.resolveConflict(conflict.path, "ours");
        await this.advanceConflict();
        break;
      }

      case "resolveTheirs": {
        const conflict = this.conflicts[this.currentIndex];
        await this.gitService.resolveConflict(conflict.path, "theirs");
        await this.advanceConflict();
        break;
      }

      case "resolveMerged": {
        const conflict = this.conflicts[this.currentIndex];
        const content = msg.content as string;
        await this.gitService.resolveConflict(conflict.path, "merged", content);
        await this.advanceConflict();
        break;
      }

      case "navigateTo": {
        const index = msg.index as number;
        if (index >= 0 && index < this.conflicts.length) {
          this.currentIndex = index;
          this.sendConflictData();
        }
        break;
      }

      case "abortMerge":
        await this.gitService.abortMerge();
        vscode.window.showInformationMessage("Merge aborted");
        this.panel?.dispose();
        break;
    }
  }

  private async advanceConflict(): Promise<void> {
    this.conflicts = await this.gitService.getMergeConflicts();

    if (this.conflicts.length === 0) {
      this.panel?.webview.postMessage({ type: "allResolved" });
      vscode.window.showInformationMessage("All merge conflicts resolved!");
      return;
    }

    if (this.currentIndex >= this.conflicts.length) {
      this.currentIndex = this.conflicts.length - 1;
    }
    this.sendConflictData();
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
    .toolbar {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background); flex-shrink: 0;
    }
    .toolbar .file-path { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar .conflict-nav { color: var(--vscode-descriptionForeground); font-size: 12px; }
    .toolbar button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; font-size: 12px;
    }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .toolbar button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .toolbar button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .toolbar button.danger { background: #e06c75; color: #fff; }
    .panes { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; flex: 1; overflow: hidden; gap: 1px; background: var(--vscode-panel-border); }
    .pane {
      display: flex; flex-direction: column; overflow: hidden;
      background: var(--vscode-editor-background);
    }
    .pane-header {
      padding: 4px 8px; font-weight: 600; font-size: 11px;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex; align-items: center; justify-content: space-between;
    }
    .pane-header button { font-size: 11px; padding: 2px 8px; }
    .pane-content {
      flex: 1; overflow: auto; padding: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5;
    }
    .pane-content pre {
      margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-all;
      tab-size: 4;
    }
    .pane-content textarea {
      width: 100%; height: 100%; border: none; resize: none;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      line-height: 1.5; padding: 8px; outline: none; tab-size: 4;
    }
    .pane.base { grid-column: 1 / -1; }
    .pane.result { grid-column: 1 / -1; }
    .resolved-banner {
      display: none; align-items: center; justify-content: center;
      flex: 1; flex-direction: column; gap: 12px;
      color: var(--vscode-descriptionForeground); font-size: 16px;
    }
    .resolved-banner.visible { display: flex; }
    .resolved-banner .icon { font-size: 48px; color: #98c379; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="file-path" id="filePath">—</span>
    <span class="conflict-nav" id="conflictNav">0/0</span>
    <button class="secondary" id="prevBtn" title="Previous conflict">← Prev</button>
    <button class="secondary" id="nextBtn" title="Next conflict">Next →</button>
    <button id="acceptOurs">Accept Ours</button>
    <button id="acceptTheirs">Accept Theirs</button>
    <button id="acceptBoth">Accept Both</button>
    <button id="saveResult">Save Result</button>
    <button class="danger" id="abortMerge">Abort Merge</button>
  </div>

  <div class="panes" id="panesContainer">
    <div class="pane base">
      <div class="pane-header">Base (Common Ancestor)</div>
      <div class="pane-content"><pre id="baseContent"></pre></div>
    </div>
    <div class="pane ours">
      <div class="pane-header">
        <span>Ours (Current Branch)</span>
        <button id="useOurs">Use All Ours</button>
      </div>
      <div class="pane-content"><pre id="oursContent"></pre></div>
    </div>
    <div class="pane theirs">
      <div class="pane-header">
        <span>Theirs (Incoming)</span>
        <button id="useTheirs">Use All Theirs</button>
      </div>
      <div class="pane-content"><pre id="theirsContent"></pre></div>
    </div>
    <div class="pane result">
      <div class="pane-header">Result (Edit below)</div>
      <div class="pane-content"><textarea id="resultContent" spellcheck="false"></textarea></div>
    </div>
  </div>

  <div class="resolved-banner" id="resolvedBanner">
    <div class="icon">✓</div>
    <div>All merge conflicts have been resolved!</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentConflict = null;

    const filePath = document.getElementById('filePath');
    const conflictNav = document.getElementById('conflictNav');
    const baseContent = document.getElementById('baseContent');
    const oursContent = document.getElementById('oursContent');
    const theirsContent = document.getElementById('theirsContent');
    const resultContent = document.getElementById('resultContent');
    const panesContainer = document.getElementById('panesContainer');
    const resolvedBanner = document.getElementById('resolvedBanner');

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function showConflict(data) {
      currentConflict = data.conflict;
      filePath.textContent = data.conflict.path;
      conflictNav.textContent = (data.currentIndex + 1) + '/' + data.totalConflicts;

      baseContent.textContent = data.conflict.base || '(empty)';
      oursContent.textContent = data.conflict.ours || '(empty)';
      theirsContent.textContent = data.conflict.theirs || '(empty)';
      resultContent.value = data.conflict.ours || '';

      panesContainer.style.display = 'grid';
      resolvedBanner.classList.remove('visible');
    }

    document.getElementById('prevBtn').addEventListener('click', () => {
      const cur = parseInt(conflictNav.textContent.split('/')[0]) - 1;
      if (cur > 0) {
        vscode.postMessage({ type: 'navigateTo', index: cur - 1 });
      }
    });

    document.getElementById('nextBtn').addEventListener('click', () => {
      const parts = conflictNav.textContent.split('/');
      const cur = parseInt(parts[0]);
      const total = parseInt(parts[1]);
      if (cur < total) {
        vscode.postMessage({ type: 'navigateTo', index: cur });
      }
    });

    document.getElementById('acceptOurs').addEventListener('click', () => {
      vscode.postMessage({ type: 'resolveOurs' });
    });

    document.getElementById('acceptTheirs').addEventListener('click', () => {
      vscode.postMessage({ type: 'resolveTheirs' });
    });

    document.getElementById('acceptBoth').addEventListener('click', () => {
      if (!currentConflict) return;
      const ours = currentConflict.ours || '';
      const theirs = currentConflict.theirs || '';
      const separator = ours.endsWith('\\n') || ours === '' ? '' : '\\n';
      resultContent.value = ours + separator + theirs;
    });

    document.getElementById('saveResult').addEventListener('click', () => {
      vscode.postMessage({ type: 'resolveMerged', content: resultContent.value });
    });

    document.getElementById('useOurs').addEventListener('click', () => {
      if (currentConflict) resultContent.value = currentConflict.ours || '';
    });

    document.getElementById('useTheirs').addEventListener('click', () => {
      if (currentConflict) resultContent.value = currentConflict.theirs || '';
    });

    document.getElementById('abortMerge').addEventListener('click', () => {
      vscode.postMessage({ type: 'abortMerge' });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'conflictData') {
        showConflict(msg);
      } else if (msg.type === 'allResolved') {
        panesContainer.style.display = 'none';
        resolvedBanner.classList.add('visible');
      }
    });

    vscode.postMessage({ type: 'loadConflict' });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.panel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
