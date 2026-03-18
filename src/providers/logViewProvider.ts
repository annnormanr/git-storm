import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  GitService,
  CommitInfo,
  LogFilter,
  FileChange,
} from "../services/gitService";
import { buildGraph, GraphData, GraphNode } from "../services/graphBuilder";

const LANE_COLORS = [
  "#e06c75",
  "#61afef",
  "#98c379",
  "#d19a66",
  "#c678dd",
  "#56b6c2",
  "#e5c07b",
  "#be5046",
  "#7ec699",
  "#f8a5c2",
];

const PAGE_SIZE = 80;

function getMaxLogEntries(): number {
  return vscode.workspace
    .getConfiguration("gitstorm")
    .get<number>("maxLogEntries", 5000);
}

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
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) {
    return `${years}y ago`;
  }
  if (months > 0) {
    return `${months}mo ago`;
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
  return "just now";
}

export class LogViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "gitstorm.logView";

  private view?: vscode.WebviewView;
  private commits: CommitInfo[] = [];
  private graphData?: GraphData;
  private currentFilter: LogFilter = {};
  private loading = false;
  private pendingScrollTo?: string;

  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly gitService: GitService,
    private readonly outputChannel?: vscode.OutputChannel,
  ) {}

  private log(msg: string): void {
    this.outputChannel?.appendLine(`[LogView] ${msg}`);
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = `<!DOCTYPE html><html><body><p style="color:var(--vscode-foreground);padding:20px;">Loading git log...</p></body></html>`;

    const msgDisposable = webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          await this.handleMessage(msg);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`GitStorm: ${message}`);
        }
      },
    );
    this.disposables.push(msgDisposable);

    void this.loadAndRenderFull(webviewView);
  }

  private async loadAndRenderFull(
    webviewView: vscode.WebviewView,
  ): Promise<void> {
    try {
      const filter: LogFilter = { maxCount: PAGE_SIZE, skip: 0 };
      this.commits = await this.gitService.getLog(filter);
      this.graphData = buildGraph(this.commits);
      this.log(`Full render: got ${this.commits.length} commits`);

      const serialized = this.serializeCommits();
      const hasMore = this.commits.length === PAGE_SIZE;
      const nonce = getNonce();

      webviewView.webview.html = this.getFullHtml(
        nonce,
        serialized,
        this.graphData,
        hasMore,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Full render error: ${message}`);
      webviewView.webview.html = `<!DOCTYPE html><html><body><p style="color:#e06c75;padding:20px;">Error loading git log: ${escapeHtml(message)}</p></body></html>`;
    }
  }

  public async refresh(): Promise<void> {
    await this.loadLog(true);
  }

  public async navigateToCommit(hash: string): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.show?.(true);

    const alreadyLoaded = this.commits.some((c) => c.hash.startsWith(hash));
    if (alreadyLoaded) {
      this.postMessage({ type: "scrollToCommit", hash });
      return;
    }

    this.pendingScrollTo = hash;
    this.currentFilter = {};
    this.commits = [];
    this.graphData = undefined;
    await this.loadLog();
  }

  private async handleMessage(msg: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (msg.type) {
      case "loadLog":
        await this.loadLog();
        break;
      case "loadMore":
        await this.loadMore();
        break;
      case "filterChanged":
        this.currentFilter = {
          branch: msg.branch as string | undefined,
          author: msg.author as string | undefined,
          since: msg.since as string | undefined,
          until: msg.until as string | undefined,
          path: msg.path as string | undefined,
          search: msg.search as string | undefined,
        };
        this.commits = [];
        this.graphData = undefined;
        await this.loadLog();
        break;
      case "commitClicked":
        await this.loadCommitDetails(msg.hash as string);
        break;
      case "openFile":
        await this.openFile(msg.filePath as string);
        break;
      case "showDiff":
        await this.showDiff(msg.hash as string, msg.filePath as string);
        break;
      case "cherryPick":
        await this.cherryPick(msg.hash as string);
        break;
      case "revert":
        await this.revertCommit(msg.hash as string);
        break;
      case "reset":
        await this.resetToCommit(
          msg.hash as string,
          msg.mode as "soft" | "mixed" | "hard",
        );
        break;
      case "tag":
        await this.createTag(msg.hash as string);
        break;
      case "copyHash":
        await vscode.env.clipboard.writeText(msg.hash as string);
        vscode.window.showInformationMessage("Commit hash copied");
        break;
    }
  }

  private async loadLog(reset = false): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;

    try {
      const filter: LogFilter = {
        ...this.currentFilter,
        maxCount: PAGE_SIZE,
        skip: 0,
      };
      const newCommits = await this.gitService.getLog(filter);
      this.commits = newCommits;
      this.graphData = buildGraph(this.commits);

      this.log(`loadLog: ${this.commits.length} commits`);
      const scrollTo = this.pendingScrollTo;
      this.pendingScrollTo = undefined;
      this.postMessage({
        type: "logData",
        commits: this.serializeCommits(),
        graph: this.graphData,
        hasMore: this.commits.length === PAGE_SIZE,
        scrollTo,
      });
    } catch (err: unknown) {
      if (reset) {
        this.commits = [];
        this.graphData = undefined;
      }
      throw err;
    } finally {
      this.loading = false;
    }
  }

  private async loadMore(): Promise<void> {
    if (this.loading) {
      return;
    }
    this.loading = true;

    try {
      const filter: LogFilter = {
        ...this.currentFilter,
        maxCount: PAGE_SIZE,
        skip: this.commits.length,
      };
      const moreCommits = await this.gitService.getLog(filter);
      this.commits.push(...moreCommits);
      this.graphData = buildGraph(this.commits);
      const maxEntries = getMaxLogEntries();
      this.postMessage({
        type: "logData",
        commits: this.serializeCommits(),
        graph: this.graphData,
        hasMore:
          moreCommits.length === PAGE_SIZE && this.commits.length < maxEntries,
      });
    } finally {
      this.loading = false;
    }
  }

  private async loadCommitDetails(hash: string): Promise<void> {
    const details = await this.gitService.getCommitDetails(hash);
    this.postMessage({
      type: "commitDetails",
      commit: {
        ...details.commit,
        authorDate: details.commit.authorDate.toISOString(),
        committerDate: details.commit.committerDate.toISOString(),
      },
      files: details.files,
    });
  }

  private async openFile(filePath: string): Promise<void> {
    const repoRoot = await this.gitService.getRepoRoot();
    const uri = vscode.Uri.joinPath(vscode.Uri.file(repoRoot), filePath);
    await vscode.window.showTextDocument(uri);
  }

  private async showDiff(hash: string, filePath: string): Promise<void> {
    const commits = this.commits;
    const commit = commits.find((c) => c.hash === hash);
    const isRoot = commit && commit.parents.length === 0;
    const parentRef = isRoot
      ? "4b825dc642cb6eb9a060e54bf899d69f82cf7657"
      : `${hash}~1`;
    const left = vscode.Uri.from({
      scheme: "gitstorm-diff",
      path: filePath,
      query: `ref=${parentRef}`,
    });
    const right = vscode.Uri.from({
      scheme: "gitstorm-diff",
      path: filePath,
      query: `ref=${hash}`,
    });
    const title = `${filePath} (${hash.substring(0, 7)})`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
  }

  private async cherryPick(hash: string): Promise<void> {
    const result = await this.gitService.cherryPick(hash);
    vscode.window.showInformationMessage(`Cherry-pick: ${result}`);
    await this.refresh();
  }

  private async revertCommit(hash: string): Promise<void> {
    const result = await this.gitService.revertCommit(hash);
    vscode.window.showInformationMessage(`Revert: ${result}`);
    await this.refresh();
  }

  private async resetToCommit(
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Reset (${mode}) to ${hash.substring(0, 7)}?`,
      { modal: true },
      "Reset",
    );
    if (confirm !== "Reset") {
      return;
    }
    await this.gitService.resetToCommit(hash, mode);
    vscode.window.showInformationMessage(
      `Reset (${mode}) to ${hash.substring(0, 7)} complete`,
    );
    await this.refresh();
  }

  private async createTag(hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Tag name",
      placeHolder: "v1.0.0",
    });
    if (!name) {
      return;
    }
    const message = await vscode.window.showInputBox({
      prompt: "Tag message (leave empty for lightweight tag)",
    });
    await this.gitService.createTag(name, hash, message || undefined);
    vscode.window.showInformationMessage(`Tag "${name}" created`);
    await this.refresh();
  }

  private serializeCommits(): Record<string, unknown>[] {
    return this.commits.map((c) => ({
      ...c,
      authorDate: c.authorDate.toISOString(),
      committerDate: c.committerDate.toISOString(),
    }));
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  private postMessage(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private getFullHtml(
    nonce: string,
    commits: Record<string, unknown>[],
    graph: GraphData,
    hasMore: boolean,
  ): string {
    const dataJson = JSON.stringify({ commits, graph, hasMore })
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");

    return `<!DOCTYPE html>
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
    }
    .filter-bar {
      display: flex; flex-wrap: wrap; gap: 4px; padding: 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .filter-bar input, .filter-bar select {
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 3px 6px; font-size: 11px; border-radius: 2px;
      outline: none;
    }
    .filter-bar input:focus, .filter-bar select:focus {
      border-color: var(--vscode-focusBorder);
    }
    .filter-bar input { min-width: 80px; flex: 1; }
    .filter-bar select { min-width: 100px; }
    .commit-list { overflow-y: auto; height: calc(100vh - 40px); }
    .commit-row {
      display: flex; align-items: center; padding: 2px 6px; cursor: pointer;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, transparent);
    }
    .commit-row:hover { background: var(--vscode-list-hoverBackground); }
    .commit-row.selected { background: var(--vscode-list-activeSelectionBackground); outline: 1px solid var(--vscode-focusBorder); }
    @keyframes flashHighlight {
      0% { background: var(--vscode-editor-findMatchHighlightBackground, rgba(255,210,60,0.4)); }
      100% { background: var(--vscode-list-activeSelectionBackground); }
    }
    .commit-row.flash { animation: flashHighlight 1.5s ease-out; }
    .graph-cell { flex-shrink: 0; overflow: hidden; }
    .graph-cell svg { display: block; }
    .commit-info { flex: 1; min-width: 0; padding-left: 6px; display: flex; align-items: center; gap: 6px; }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
      color: var(--vscode-textLink-foreground); cursor: pointer; flex-shrink: 0;
    }
    .commit-subject { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
    .commit-author { color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .commit-date { color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; min-width: 50px; text-align: right; }
    .ref-badge {
      display: inline-block; padding: 1px 5px; border-radius: 3px;
      font-size: 10px; font-weight: 600; margin-right: 3px; flex-shrink: 0; white-space: nowrap;
    }
    .ref-badge.branch { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .ref-badge.tag { background: #d19a66; color: #282c34; }
    .ref-badge.head { background: var(--vscode-statusBarItem-prominentBackground, #e06c75); color: #fff; }
    .details-panel {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 8px; background: var(--vscode-sideBar-background);
      max-height: 300px; overflow-y: auto; display: none;
    }
    .details-panel.visible { display: block; }
    .details-header { font-weight: 600; margin-bottom: 4px; }
    .details-body { font-size: 12px; white-space: pre-wrap; margin-bottom: 6px; color: var(--vscode-descriptionForeground); }
    .file-list { list-style: none; }
    .file-list li {
      display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; cursor: pointer;
    }
    .file-list li:hover { text-decoration: underline; }
    .file-status { font-weight: 700; width: 14px; text-align: center; flex-shrink: 0; }
    .file-status.A { color: #98c379; }
    .file-status.M { color: #61afef; }
    .file-status.D { color: #e06c75; }
    .file-status.R { color: #d19a66; }
    .file-stats { color: var(--vscode-descriptionForeground); font-size: 11px; flex-shrink: 0; }
    .file-stats .add { color: #98c379; }
    .file-stats .del { color: #e06c75; }
    .loading { text-align: center; padding: 10px; color: var(--vscode-descriptionForeground); }
    .context-menu {
      position: fixed; background: var(--vscode-menu-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 4px 0; z-index: 999; min-width: 160px;
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
    <select id="branchFilter" title="Branch"><option value="">All branches</option></select>
    <input id="authorFilter" type="text" placeholder="Author..." title="Filter by author" />
    <input id="sinceFilter" type="date" title="Since date" />
    <input id="untilFilter" type="date" title="Until date" />
    <input id="pathFilter" type="text" placeholder="Path..." title="Filter by file path" />
    <input id="searchFilter" type="text" placeholder="Search..." title="Search commit messages" />
  </div>
  <div class="commit-list" id="commitList">
    <div class="loading">Rendering...</div>
  </div>
  <div class="details-panel" id="detailsPanel"></div>
  <div class="context-menu" id="contextMenu"></div>

  <script nonce="${nonce}">
    (function() {
      var vscode = acquireVsCodeApi();
      var LANE_COLORS = ${JSON.stringify(LANE_COLORS)};
      var ROW_HEIGHT = 24;
      var LANE_WIDTH = 12;
      var DOT_RADIUS = 3;

      var initialData = ${dataJson};
      var commits = initialData.commits;
      var graph = initialData.graph;
      var hasMore = initialData.hasMore;
      var selectedHash = null;
      var contextHash = null;

      var commitList = document.getElementById('commitList');
      var detailsPanel = document.getElementById('detailsPanel');
      var contextMenu = document.getElementById('contextMenu');

      function laneColor(idx) {
        return LANE_COLORS[idx % LANE_COLORS.length];
      }

      function renderGraphSvg(node, maxCols) {
        var w = maxCols * LANE_WIDTH + 6;
        var h = ROW_HEIGHT;
        var cy = h / 2;
        var svg = '<svg width="' + w + '" height="' + h + '" xmlns="http://www.w3.org/2000/svg">';
        for (var p = 0; p < node.parents.length; p++) {
          var parent = node.parents[p];
          var x1 = node.column * LANE_WIDTH + LANE_WIDTH / 2;
          var x2 = parent.column * LANE_WIDTH + LANE_WIDTH / 2;
          var c = laneColor(parent.color);
          if (x1 === x2) {
            svg += '<line x1="' + x1 + '" y1="' + cy + '" x2="' + x2 + '" y2="' + h + '" stroke="' + c + '" stroke-width="1.5"/>';
          } else {
            svg += '<path d="M' + x1 + ' ' + cy + ' C' + x1 + ' ' + h + ' ' + x2 + ' ' + cy + ' ' + x2 + ' ' + h + '" fill="none" stroke="' + c + '" stroke-width="1.5"/>';
          }
        }
        var cx = node.column * LANE_WIDTH + LANE_WIDTH / 2;
        var color = laneColor(node.color);
        svg += '<line x1="' + cx + '" y1="0" x2="' + cx + '" y2="' + cy + '" stroke="' + color + '" stroke-width="1.5"/>';
        svg += '<circle cx="' + cx + '" cy="' + cy + '" r="' + DOT_RADIUS + '" fill="' + color + '"/>';
        svg += '</svg>';
        return svg;
      }

      function renderRefBadges(refs) {
        if (!refs || refs.length === 0) return '';
        var html = '';
        for (var i = 0; i < refs.length; i++) {
          var ref = refs[i];
          var cls = 'branch';
          if (ref.indexOf('tag:') === 0) cls = 'tag';
          else if (ref === 'HEAD') cls = 'head';
          else if (ref.indexOf('HEAD ->') >= 0) cls = 'head';
          html += '<span class="ref-badge ' + cls + '">' + escapeHtml(ref) + '</span>';
        }
        return html;
      }

      function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
      }

      function relDate(iso) {
        var d = new Date(iso);
        var diff = Date.now() - d.getTime();
        var sec = Math.floor(diff/1000), min = Math.floor(sec/60), hr = Math.floor(min/60), days = Math.floor(hr/24), mo = Math.floor(days/30), y = Math.floor(days/365);
        if (y > 0) return y + 'y ago';
        if (mo > 0) return mo + 'mo ago';
        if (days > 0) return days + 'd ago';
        if (hr > 0) return hr + 'h ago';
        if (min > 0) return min + 'm ago';
        return 'just now';
      }

      function renderCommits() {
        var html = '';
        var maxCols = graph ? graph.maxColumns : 1;
        for (var i = 0; i < commits.length; i++) {
          var c = commits[i];
          var node = graph && graph.nodes[i] ? graph.nodes[i] : { column: 0, color: 0, parents: [] };
          var sel = c.hash === selectedHash ? ' selected' : '';
          var tip = c.hash + '\\n' + c.subject + '\\n' + c.author + ' - ' + relDate(c.authorDate);
          html += '<div class="commit-row' + sel + '" data-hash="' + c.hash + '" title="' + escapeHtml(tip) + '">';
          html += '<div class="graph-cell">' + renderGraphSvg(node, maxCols) + '</div>';
          html += '<div class="commit-info">';
          html += renderRefBadges(c.refs);
          html += '<span class="commit-hash" data-hash="' + c.hash + '">' + escapeHtml(c.abbreviatedHash) + '</span>';
          html += '<span class="commit-subject">' + escapeHtml(c.subject) + '</span>';
          html += '<span class="commit-author">' + escapeHtml(c.author) + '</span>';
          html += '<span class="commit-date">' + relDate(c.authorDate) + '</span>';
          html += '</div></div>';
        }
        if (hasMore) {
          html += '<div class="loading" id="loadMoreSentinel">Loading more...</div>';
        }
        if (commits.length === 0) {
          html = '<div class="loading">No commits found</div>';
        }
        commitList.innerHTML = html;
        observeLoadMore();
      }

      function observeLoadMore() {
        var sentinel = document.getElementById('loadMoreSentinel');
        if (!sentinel) return;
        var obs = new IntersectionObserver(function(entries) {
          if (entries[0].isIntersecting) {
            obs.disconnect();
            vscode.postMessage({ type: 'loadMore' });
          }
        }, { root: commitList, threshold: 0.1 });
        obs.observe(sentinel);
      }

      commitList.addEventListener('click', function(e) {
        var row = e.target.closest('.commit-row');
        if (!row) return;
        var hash = row.dataset.hash;
        selectedHash = hash;
        renderCommits();
        vscode.postMessage({ type: 'commitClicked', hash: hash });
      });

      commitList.addEventListener('contextmenu', function(e) {
        var row = e.target.closest('.commit-row');
        if (!row) return;
        e.preventDefault();
        contextHash = row.dataset.hash;
        showContextMenu(e.clientX, e.clientY);
      });

      function showContextMenu(x, y) {
        contextMenu.innerHTML = [
          '<div class="context-menu-item" data-action="cherryPick">Cherry-pick</div>',
          '<div class="context-menu-item" data-action="revert">Revert</div>',
          '<div class="context-menu-sep"></div>',
          '<div class="context-menu-item" data-action="resetSoft">Reset (soft)</div>',
          '<div class="context-menu-item" data-action="resetMixed">Reset (mixed)</div>',
          '<div class="context-menu-item" data-action="resetHard">Reset (hard)</div>',
          '<div class="context-menu-sep"></div>',
          '<div class="context-menu-item" data-action="tag">Create tag...</div>',
          '<div class="context-menu-item" data-action="copyHash">Copy hash</div>'
        ].join('');
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
        contextMenu.classList.add('visible');
      }

      document.addEventListener('click', function() {
        contextMenu.classList.remove('visible');
      });

      contextMenu.addEventListener('click', function(e) {
        var item = e.target.closest('.context-menu-item');
        if (!item || !contextHash) return;
        var action = item.dataset.action;
        if (action === 'cherryPick') vscode.postMessage({ type: 'cherryPick', hash: contextHash });
        else if (action === 'revert') vscode.postMessage({ type: 'revert', hash: contextHash });
        else if (action === 'resetSoft') vscode.postMessage({ type: 'reset', hash: contextHash, mode: 'soft' });
        else if (action === 'resetMixed') vscode.postMessage({ type: 'reset', hash: contextHash, mode: 'mixed' });
        else if (action === 'resetHard') vscode.postMessage({ type: 'reset', hash: contextHash, mode: 'hard' });
        else if (action === 'tag') vscode.postMessage({ type: 'tag', hash: contextHash });
        else if (action === 'copyHash') vscode.postMessage({ type: 'copyHash', hash: contextHash });
        contextMenu.classList.remove('visible');
      });

      window.addEventListener('message', function(e) {
        var msg = e.data;
        if (msg.type === 'logData') {
          commits = msg.commits;
          graph = msg.graph;
          hasMore = msg.hasMore;
          if (msg.scrollTo) {
            selectedHash = msg.scrollTo;
          }
          renderCommits();
          if (msg.scrollTo) {
            scrollAndFlash(msg.scrollTo);
          }
        } else if (msg.type === 'commitDetails') {
          showDetails(msg.commit, msg.files);
        } else if (msg.type === 'scrollToCommit') {
          selectedHash = msg.hash;
          renderCommits();
          scrollAndFlash(msg.hash);
        }
      });

      function scrollAndFlash(hash) {
        var row = commitList.querySelector('[data-hash="' + hash + '"]')
          || commitList.querySelector('[data-hash^="' + hash + '"]');
        if (row) {
          selectedHash = row.dataset.hash;
          renderCommits();
          var updatedRow = commitList.querySelector('[data-hash="' + selectedHash + '"]');
          if (updatedRow) {
            updatedRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
            updatedRow.classList.add('flash');
            updatedRow.addEventListener('animationend', function() { updatedRow.classList.remove('flash'); }, { once: true });
          }
          vscode.postMessage({ type: 'commitClicked', hash: row.dataset.hash });
        }
      }

      function showDetails(commit, files) {
        var html = '<div class="details-header">' + escapeHtml(commit.hash.substring(0, 10)) + ' - ' + escapeHtml(commit.subject) + '</div>';
        if (commit.body) {
          html += '<div class="details-body">' + escapeHtml(commit.body) + '</div>';
        }
        html += '<div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:6px">';
        html += escapeHtml(commit.author) + ' &lt;' + escapeHtml(commit.authorEmail) + '&gt; - ' + relDate(commit.authorDate);
        html += '</div>';
        html += '<ul class="file-list">';
        for (var i = 0; i < files.length; i++) {
          var f = files[i];
          html += '<li data-path="' + escapeHtml(f.path) + '" data-hash="' + commit.hash + '">';
          html += '<span class="file-status ' + f.status + '">' + f.status + '</span>';
          html += '<span>' + escapeHtml(f.path) + '</span>';
          html += '<span class="file-stats"><span class="add">+' + f.additions + '</span> <span class="del">-' + f.deletions + '</span></span>';
          html += '</li>';
        }
        html += '</ul>';
        detailsPanel.innerHTML = html;
        detailsPanel.classList.add('visible');
      }

      detailsPanel.addEventListener('click', function(e) {
        var li = e.target.closest('.file-list li');
        if (!li) return;
        var path = li.dataset.path;
        var hash = li.dataset.hash;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          vscode.postMessage({ type: 'openFile', filePath: path });
        } else {
          vscode.postMessage({ type: 'showDiff', hash: hash, filePath: path });
        }
      });

      function emitFilter() {
        vscode.postMessage({
          type: 'filterChanged',
          branch: document.getElementById('branchFilter').value || undefined,
          author: document.getElementById('authorFilter').value || undefined,
          since: document.getElementById('sinceFilter').value || undefined,
          until: document.getElementById('untilFilter').value || undefined,
          path: document.getElementById('pathFilter').value || undefined,
          search: document.getElementById('searchFilter').value || undefined
        });
      }

      document.getElementById('branchFilter').addEventListener('change', emitFilter);

      var filterTimer = null;
      var filterIds = ['authorFilter', 'sinceFilter', 'untilFilter', 'pathFilter', 'searchFilter'];
      for (var fi = 0; fi < filterIds.length; fi++) {
        document.getElementById(filterIds[fi]).addEventListener('input', function() {
          clearTimeout(filterTimer);
          filterTimer = setTimeout(emitFilter, 400);
        });
      }

      renderCommits();
    })();
  </script>
</body>
</html>`;
  }
}
