import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  GitHubService,
  PullRequest,
  PRComment,
  PRReview,
} from "../services/githubService";

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

interface SerializedPR {
  number: number;
  title: string;
  body: string;
  state: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  baseBranch: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewers: string[];
  labels: string[];
  url: string;
  mergeable: boolean;
  draft: boolean;
}

function serializePR(pr: PullRequest): SerializedPR {
  return {
    ...pr,
    createdAt: pr.createdAt.toISOString(),
    updatedAt: pr.updatedAt.toISOString(),
  };
}

function serializeComment(c: PRComment): Record<string, unknown> {
  return {
    ...c,
    createdAt: c.createdAt.toISOString(),
  };
}

function serializeReview(r: PRReview): Record<string, unknown> {
  return {
    ...r,
    submittedAt: r.submittedAt.toISOString(),
    comments: r.comments.map(serializeComment),
  };
}

export class PRViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  public static readonly viewType = "gitstorm.prView";

  private view?: vscode.WebviewView;
  private detailPanel?: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly githubService: GitHubService,
  ) {}

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

    webviewView.webview.html = this.getListHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      async (msg) => {
        try {
          await this.handleListMessage(msg);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`GitStorm: ${message}`);
        }
      },
      null,
      this.disposables,
    );
  }

  public async refresh(): Promise<void> {
    const token = await this.githubService.getTokenSilent();
    if (!token) {
      this.view?.webview.postMessage({ type: "tokenRequired" });
      return;
    }
    this.view?.webview.postMessage({ type: "loading" });
    try {
      const prs = await this.githubService.listPullRequests("open");
      this.view?.webview.postMessage({
        type: "prList",
        pullRequests: prs.map(serializePR),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.view?.webview.postMessage({ type: "error", message });
    }
  }

  public show(): void {
    if (this.view) {
      this.view.show?.(true);
    }
  }

  public async showReview(prNumber: number): Promise<void> {
    await this.openPRDetail(prNumber);
  }

  private async handleListMessage(msg: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (msg.type) {
      case "loadPRs": {
        const token = await this.githubService.getTokenSilent();
        if (!token) {
          this.view?.webview.postMessage({ type: "tokenRequired" });
          return;
        }
        const state = (msg.state as string) || "open";
        const prs = await this.githubService.listPullRequests(
          state as "open" | "closed" | "all",
        );
        this.view?.webview.postMessage({
          type: "prList",
          pullRequests: prs.map(serializePR),
        });
        break;
      }
      case "configureToken": {
        try {
          await this.githubService.promptForToken();
          this.view?.webview.postMessage({ type: "loading" });
          const prs = await this.githubService.listPullRequests("open");
          this.view?.webview.postMessage({
            type: "prList",
            pullRequests: prs.map(serializePR),
          });
        } catch {
          this.view?.webview.postMessage({ type: "tokenRequired" });
        }
        break;
      }
      case "clearToken": {
        this.githubService.clearToken();
        this.view?.webview.postMessage({ type: "tokenRequired" });
        break;
      }
      case "openPR":
        await this.openPRDetail(msg.number as number);
        break;

      case "createPR":
        await this.showCreatePRPanel();
        break;
    }
  }

  private async openPRDetail(prNumber: number): Promise<void> {
    if (this.detailPanel) {
      this.detailPanel.reveal();
    } else {
      this.detailPanel = vscode.window.createWebviewPanel(
        "gitstorm.prDetail",
        `PR #${prNumber}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        },
      );

      this.detailPanel.onDidDispose(
        () => {
          this.detailPanel = undefined;
        },
        null,
        this.disposables,
      );

      this.detailPanel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
            await this.handleDetailMessage(msg);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`GitStorm: ${message}`);
          }
        },
        null,
        this.disposables,
      );
    }

    this.detailPanel.title = `PR #${prNumber}`;
    this.detailPanel.webview.html = this.getDetailHtml(
      this.detailPanel.webview,
    );

    const [pr, comments, reviews] = await Promise.all([
      this.githubService.getPullRequest(prNumber),
      this.githubService.getPRComments(prNumber),
      this.githubService.getPRReviews(prNumber),
    ]);

    this.detailPanel.webview.postMessage({
      type: "prDetail",
      pr: serializePR(pr),
      comments: comments.map(serializeComment),
      reviews: reviews.map(serializeReview),
    });
  }

  private async handleDetailMessage(msg: {
    type: string;
    [key: string]: unknown;
  }): Promise<void> {
    switch (msg.type) {
      case "addComment": {
        const prNumber = msg.prNumber as number;
        const body = msg.body as string;
        const path = msg.path as string | undefined;
        const line = msg.line as number | undefined;
        const side = msg.side as string | undefined;
        await this.githubService.addPRComment(prNumber, body, path, line, side);
        await this.refreshPRDetail(prNumber);
        break;
      }
      case "submitReview": {
        const prNumber = msg.prNumber as number;
        const event = msg.event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
        const body = msg.body as string | undefined;
        await this.githubService.submitReview(prNumber, event, body);
        vscode.window.showInformationMessage(`Review submitted: ${event}`);
        await this.refreshPRDetail(prNumber);
        break;
      }
      case "mergePR": {
        const prNumber = msg.prNumber as number;
        const method = msg.method as "merge" | "squash" | "rebase";
        const confirm = await vscode.window.showWarningMessage(
          `Merge PR #${prNumber} using "${method}"?`,
          { modal: true },
          "Merge",
        );
        if (confirm !== "Merge") {
          return;
        }
        await this.githubService.mergePullRequest(prNumber, method);
        vscode.window.showInformationMessage(`PR #${prNumber} merged`);
        await this.refreshPRDetail(prNumber);
        await this.refresh();
        break;
      }
      case "createPR": {
        const title = msg.title as string;
        const body = msg.body as string;
        const head = msg.head as string;
        const base = msg.base as string;
        const draft = msg.draft as boolean;
        const pr = await this.githubService.createPullRequest(
          title,
          body,
          head,
          base,
          draft,
        );
        vscode.window.showInformationMessage(`PR #${pr.number} created`);
        await this.openPRDetail(pr.number);
        await this.refresh();
        break;
      }
    }
  }

  private async refreshPRDetail(prNumber: number): Promise<void> {
    if (!this.detailPanel) {
      return;
    }
    const [pr, comments, reviews] = await Promise.all([
      this.githubService.getPullRequest(prNumber),
      this.githubService.getPRComments(prNumber),
      this.githubService.getPRReviews(prNumber),
    ]);
    this.detailPanel.webview.postMessage({
      type: "prDetail",
      pr: serializePR(pr),
      comments: comments.map(serializeComment),
      reviews: reviews.map(serializeReview),
    });
  }

  private async showCreatePRPanel(): Promise<void> {
    if (this.detailPanel) {
      this.detailPanel.reveal();
    } else {
      this.detailPanel = vscode.window.createWebviewPanel(
        "gitstorm.prDetail",
        "Create Pull Request",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [this.extensionUri],
        },
      );

      this.detailPanel.onDidDispose(
        () => {
          this.detailPanel = undefined;
        },
        null,
        this.disposables,
      );

      this.detailPanel.webview.onDidReceiveMessage(
        async (msg) => {
          try {
            await this.handleDetailMessage(msg);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`GitStorm: ${message}`);
          }
        },
        null,
        this.disposables,
      );
    }

    this.detailPanel.title = "Create Pull Request";
    this.detailPanel.webview.html = this.getDetailHtml(
      this.detailPanel.webview,
      "create",
    );
  }

  // ── List HTML (sidebar) ────────────────────────────────────────────

  private getListHtml(webview: vscode.Webview): string {
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
    }
    .toolbar {
      display: flex; align-items: center; gap: 4px; padding: 6px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
    }
    .toolbar select, .toolbar button {
      font-size: 11px; padding: 3px 6px; border-radius: 2px;
    }
    .toolbar select {
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border); outline: none;
    }
    .toolbar button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; cursor: pointer;
    }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .pr-list { overflow-y: auto; height: calc(100vh - 38px); }
    .pr-item {
      padding: 8px 10px; cursor: pointer;
      border-bottom: 1px solid var(--vscode-list-inactiveSelectionBackground, transparent);
    }
    .pr-item:hover { background: var(--vscode-list-hoverBackground); }
    .pr-title { font-size: 12px; font-weight: 500; display: flex; align-items: center; gap: 4px; }
    .pr-number { color: var(--vscode-descriptionForeground); font-weight: 400; }
    .pr-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .pr-labels { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
    .pr-label {
      display: inline-block; padding: 1px 5px; border-radius: 3px;
      font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    }
    .state-badge {
      display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 10px; font-weight: 600;
    }
    .state-badge.open { background: #238636; color: #fff; }
    .state-badge.closed { background: #da3633; color: #fff; }
    .state-badge.merged { background: #8957e5; color: #fff; }
    .state-badge.draft { background: #6e7681; color: #fff; }
    .loading { text-align: center; padding: 20px; color: var(--vscode-descriptionForeground); }
    .error { padding: 12px; color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <div class="toolbar">
    <select id="stateFilter">
      <option value="open" selected>Open</option>
      <option value="closed">Closed</option>
      <option value="all">All</option>
    </select>
    <button id="createPRBtn">+ New PR</button>
    <button id="clearTokenBtn" style="margin-left:auto">Clear Token</button>
  </div>
  <div class="pr-list" id="prList">
    <div class="loading">Loading pull requests...</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const prList = document.getElementById('prList');

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function relDate(iso) {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const s = Math.floor(diff/1000), m = Math.floor(s/60), h = Math.floor(m/60), days = Math.floor(h/24);
      if (days > 365) return Math.floor(days/365) + 'y ago';
      if (days > 30) return Math.floor(days/30) + 'mo ago';
      if (days > 0) return days + 'd ago';
      if (h > 0) return h + 'h ago';
      if (m > 0) return m + 'm ago';
      return 'just now';
    }

    function renderPRs(prs) {
      if (prs.length === 0) {
        prList.innerHTML = '<div class="loading">No pull requests found</div>';
        return;
      }
      let html = '';
      for (const pr of prs) {
        let stateClass = pr.state;
        if (pr.draft && pr.state === 'open') stateClass = 'draft';
        html += '<div class="pr-item" data-number="' + pr.number + '">';
        html += '<div class="pr-title"><span class="state-badge ' + stateClass + '">' + (pr.draft ? 'Draft' : pr.state) + '</span>';
        html += '<span class="pr-number">#' + pr.number + '</span> ' + escapeHtml(pr.title) + '</div>';
        html += '<div class="pr-meta">' + escapeHtml(pr.author) + ' — ' + relDate(pr.createdAt) + ' — ';
        html += '<span style="color:#98c379">+' + pr.additions + '</span> <span style="color:#e06c75">-' + pr.deletions + '</span> (' + pr.changedFiles + ' files)';
        html += '</div>';
        if (pr.labels.length > 0) {
          html += '<div class="pr-labels">';
          for (const l of pr.labels) html += '<span class="pr-label">' + escapeHtml(l) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }
      prList.innerHTML = html;
    }

    prList.addEventListener('click', e => {
      const item = e.target.closest('.pr-item');
      if (!item) return;
      vscode.postMessage({ type: 'openPR', number: parseInt(item.dataset.number) });
    });

    document.getElementById('stateFilter').addEventListener('change', e => {
      prList.innerHTML = '<div class="loading">Loading...</div>';
      vscode.postMessage({ type: 'loadPRs', state: e.target.value });
    });

    document.getElementById('createPRBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'createPR' });
    });

    document.getElementById('clearTokenBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'clearToken' });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'prList') renderPRs(msg.pullRequests);
      else if (msg.type === 'loading') prList.innerHTML = '<div class="loading">Loading...</div>';
      else if (msg.type === 'error') prList.innerHTML = '<div class="error">' + escapeHtml(msg.message) + '</div>';
      else if (msg.type === 'tokenRequired') {
        prList.innerHTML = '<div style="padding:20px;text-align:center;">'
          + '<p style="color:var(--vscode-descriptionForeground);font-size:12px;margin-bottom:12px;">GitHub token not configured.</p>'
          + '<button id="configTokenBtn" style="background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:2px;cursor:pointer;font-size:12px;">Configure Token</button>'
          + '</div>';
        document.getElementById('configTokenBtn').addEventListener('click', function() {
          vscode.postMessage({ type: 'configureToken' });
        });
      }
    });

    vscode.postMessage({ type: 'loadPRs', state: 'open' });
  </script>
</body>
</html>`;
  }

  // ── Detail HTML (panel) ────────────────────────────────────────────

  private getDetailHtml(
    webview: vscode.Webview,
    initialMode: "detail" | "create" = "detail",
  ): string {
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
      padding: 16px; overflow-y: auto;
    }
    h1 { font-size: 18px; margin-bottom: 8px; }
    h2 { font-size: 14px; margin: 16px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .pr-header { margin-bottom: 16px; }
    .pr-meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 4px 0; }
    .pr-body { font-size: 13px; white-space: pre-wrap; margin: 8px 0; line-height: 1.5; }
    .state-badge {
      display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: 600;
    }
    .state-badge.open { background: #238636; color: #fff; }
    .state-badge.closed { background: #da3633; color: #fff; }
    .state-badge.merged { background: #8957e5; color: #fff; }
    .state-badge.draft { background: #6e7681; color: #fff; }
    .label-badge {
      display: inline-block; padding: 1px 6px; border-radius: 3px;
      font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      margin-right: 4px;
    }
    .comment {
      border: 1px solid var(--vscode-panel-border); border-radius: 4px;
      margin-bottom: 8px; overflow: hidden;
    }
    .comment-header {
      padding: 6px 10px; font-size: 12px; font-weight: 600;
      background: var(--vscode-sideBar-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .comment-body { padding: 8px 10px; font-size: 13px; white-space: pre-wrap; line-height: 1.5; }
    .comment-file { font-size: 11px; color: var(--vscode-textLink-foreground); }
    .review-state {
      display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-left: 4px;
    }
    .review-state.APPROVED { background: #238636; color: #fff; }
    .review-state.CHANGES_REQUESTED { background: #da3633; color: #fff; }
    .review-state.COMMENTED { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    textarea {
      width: 100%; min-height: 80px; margin: 8px 0; padding: 8px; resize: vertical;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border); border-radius: 2px;
      font-family: var(--vscode-font-family); font-size: 13px; outline: none;
    }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    input[type="text"] {
      width: 100%; padding: 6px 8px; margin: 4px 0;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border); border-radius: 2px;
      font-size: 13px; outline: none;
    }
    input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
    .btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
    button {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; padding: 6px 14px; border-radius: 2px; cursor: pointer; font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger { background: #da3633; color: #fff; }
    select {
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border); padding: 4px 8px; border-radius: 2px;
      font-size: 12px; outline: none;
    }
    .loading { text-align: center; padding: 40px; color: var(--vscode-descriptionForeground); }
    .section { margin-bottom: 16px; }
    label { font-size: 12px; font-weight: 600; display: block; margin-top: 8px; }
    .checkbox-row { display: flex; align-items: center; gap: 6px; margin-top: 8px; font-size: 12px; }
    #prDetail { display: none; }
    #createForm { display: none; }
  </style>
</head>
<body>
  <div id="loadingMsg" class="loading">Loading pull request...</div>

  <div id="prDetail">
    <div class="pr-header">
      <h1><span id="prTitle"></span> <span id="prNumber" style="color:var(--vscode-descriptionForeground);font-weight:400"></span></h1>
      <div class="pr-meta">
        <span id="prState"></span>
        <span id="prLabels"></span>
      </div>
      <div class="pr-meta" id="prMeta"></div>
      <div class="pr-body" id="prBody"></div>
    </div>

    <div class="section">
      <h2>Merge</h2>
      <div class="btn-row">
        <select id="mergeMethod">
          <option value="merge">Merge commit</option>
          <option value="squash">Squash and merge</option>
          <option value="rebase">Rebase and merge</option>
        </select>
        <button id="mergeBtn">Merge PR</button>
      </div>
    </div>

    <div class="section">
      <h2>Conversation</h2>
      <div id="conversation"></div>

      <h2>Add Comment</h2>
      <textarea id="commentBody" placeholder="Write a comment..."></textarea>
      <div class="btn-row">
        <button id="addCommentBtn">Comment</button>
      </div>
    </div>

    <div class="section">
      <h2>Submit Review</h2>
      <textarea id="reviewBody" placeholder="Review summary (optional)..."></textarea>
      <div class="btn-row">
        <button class="secondary" id="reviewComment">Comment</button>
        <button style="background:#238636" id="reviewApprove">Approve</button>
        <button class="danger" id="reviewRequestChanges">Request Changes</button>
      </div>
    </div>
  </div>

  <div id="createForm">
    <h1>Create Pull Request</h1>
    <label for="crTitle">Title</label>
    <input type="text" id="crTitle" placeholder="PR title" />
    <label for="crBody">Description</label>
    <textarea id="crBody" placeholder="Describe your changes..." style="min-height:120px"></textarea>
    <label for="crHead">Head branch (your branch)</label>
    <input type="text" id="crHead" placeholder="feature-branch" />
    <label for="crBase">Base branch</label>
    <input type="text" id="crBase" placeholder="main" value="main" />
    <div class="checkbox-row">
      <input type="checkbox" id="crDraft" />
      <label for="crDraft" style="margin:0">Create as draft</label>
    </div>
    <div class="btn-row" style="margin-top:12px">
      <button id="submitCreatePR">Create Pull Request</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentPR = null;

    const loadingMsg = document.getElementById('loadingMsg');
    const prDetailEl = document.getElementById('prDetail');
    const createFormEl = document.getElementById('createForm');

    function escapeHtml(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    function relDate(iso) {
      const d = new Date(iso);
      const diff = Date.now() - d.getTime();
      const s = Math.floor(diff/1000), m = Math.floor(s/60), h = Math.floor(m/60), days = Math.floor(h/24);
      if (days > 365) return Math.floor(days/365) + 'y ago';
      if (days > 30) return Math.floor(days/30) + 'mo ago';
      if (days > 0) return days + 'd ago';
      if (h > 0) return h + 'h ago';
      if (m > 0) return m + 'm ago';
      return 'just now';
    }

    function showPR(pr, comments, reviews) {
      currentPR = pr;
      loadingMsg.style.display = 'none';
      createFormEl.style.display = 'none';
      prDetailEl.style.display = 'block';

      document.getElementById('prTitle').textContent = pr.title;
      document.getElementById('prNumber').textContent = '#' + pr.number;

      let stateClass = pr.state;
      if (pr.draft && pr.state === 'open') stateClass = 'draft';
      document.getElementById('prState').innerHTML = '<span class="state-badge ' + stateClass + '">' + (pr.draft ? 'Draft' : pr.state) + '</span>';

      let labelsHtml = '';
      for (const l of pr.labels) labelsHtml += '<span class="label-badge">' + escapeHtml(l) + '</span>';
      document.getElementById('prLabels').innerHTML = labelsHtml;

      document.getElementById('prMeta').innerHTML = escapeHtml(pr.author) + ' wants to merge <strong>' + escapeHtml(pr.headBranch) + '</strong> into <strong>' + escapeHtml(pr.baseBranch) + '</strong> — ' + relDate(pr.createdAt) + '<br/><span style="color:#98c379">+' + pr.additions + '</span> <span style="color:#e06c75">-' + pr.deletions + '</span> (' + pr.changedFiles + ' files)' + (pr.reviewers.length > 0 ? '<br/>Reviewers: ' + pr.reviewers.map(escapeHtml).join(', ') : '');
      document.getElementById('prBody').textContent = pr.body || '(no description)';

      let convHtml = '';
      const allItems = [];

      for (const c of comments) {
        allItems.push({ kind: 'comment', data: c, time: new Date(c.createdAt).getTime() });
      }
      for (const r of reviews) {
        allItems.push({ kind: 'review', data: r, time: new Date(r.submittedAt).getTime() });
      }
      allItems.sort((a, b) => a.time - b.time);

      for (const item of allItems) {
        if (item.kind === 'comment') {
          const c = item.data;
          convHtml += '<div class="comment">';
          convHtml += '<div class="comment-header">' + escapeHtml(c.author) + ' commented ' + relDate(c.createdAt);
          if (c.path) convHtml += ' <span class="comment-file">on ' + escapeHtml(c.path) + (c.line ? ':' + c.line : '') + '</span>';
          convHtml += '</div>';
          convHtml += '<div class="comment-body">' + escapeHtml(c.body) + '</div>';
          convHtml += '</div>';
        } else {
          const r = item.data;
          convHtml += '<div class="comment">';
          convHtml += '<div class="comment-header">' + escapeHtml(r.author) + ' <span class="review-state ' + r.state + '">' + r.state.replace(/_/g, ' ') + '</span> ' + relDate(r.submittedAt) + '</div>';
          if (r.body) convHtml += '<div class="comment-body">' + escapeHtml(r.body) + '</div>';
          for (const rc of (r.comments || [])) {
            convHtml += '<div style="margin-left:16px;border-left:2px solid var(--vscode-panel-border);padding-left:8px;margin-top:4px">';
            convHtml += '<div style="font-size:11px;font-weight:600">' + escapeHtml(rc.author);
            if (rc.path) convHtml += ' <span class="comment-file">on ' + escapeHtml(rc.path) + (rc.line ? ':' + rc.line : '') + '</span>';
            convHtml += '</div>';
            convHtml += '<div class="comment-body">' + escapeHtml(rc.body) + '</div>';
            convHtml += '</div>';
          }
          convHtml += '</div>';
        }
      }

      if (allItems.length === 0) {
        convHtml = '<div style="color:var(--vscode-descriptionForeground);font-size:12px">No comments yet</div>';
      }

      document.getElementById('conversation').innerHTML = convHtml;
    }

    document.getElementById('mergeBtn').addEventListener('click', () => {
      if (!currentPR) return;
      vscode.postMessage({
        type: 'mergePR',
        prNumber: currentPR.number,
        method: document.getElementById('mergeMethod').value,
      });
    });

    document.getElementById('addCommentBtn').addEventListener('click', () => {
      if (!currentPR) return;
      const body = document.getElementById('commentBody').value.trim();
      if (!body) return;
      vscode.postMessage({ type: 'addComment', prNumber: currentPR.number, body: body });
      document.getElementById('commentBody').value = '';
    });

    document.getElementById('reviewComment').addEventListener('click', () => {
      if (!currentPR) return;
      vscode.postMessage({ type: 'submitReview', prNumber: currentPR.number, event: 'COMMENT', body: document.getElementById('reviewBody').value });
    });
    document.getElementById('reviewApprove').addEventListener('click', () => {
      if (!currentPR) return;
      vscode.postMessage({ type: 'submitReview', prNumber: currentPR.number, event: 'APPROVE', body: document.getElementById('reviewBody').value });
    });
    document.getElementById('reviewRequestChanges').addEventListener('click', () => {
      if (!currentPR) return;
      vscode.postMessage({ type: 'submitReview', prNumber: currentPR.number, event: 'REQUEST_CHANGES', body: document.getElementById('reviewBody').value });
    });

    document.getElementById('submitCreatePR').addEventListener('click', () => {
      const title = document.getElementById('crTitle').value.trim();
      const body = document.getElementById('crBody').value;
      const head = document.getElementById('crHead').value.trim();
      const base = document.getElementById('crBase').value.trim();
      const draft = document.getElementById('crDraft').checked;
      if (!title || !head || !base) return;
      vscode.postMessage({ type: 'createPR', title, body, head, base, draft });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'prDetail') {
        showPR(msg.pr, msg.comments, msg.reviews);
      } else if (msg.type === 'showCreateForm') {
        loadingMsg.style.display = 'none';
        prDetailEl.style.display = 'none';
        createFormEl.style.display = 'block';
      }
    });

    const initialMode = '${initialMode}';
    if (initialMode === 'create') {
      loadingMsg.style.display = 'none';
      prDetailEl.style.display = 'none';
      createFormEl.style.display = 'block';
    }
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    this.detailPanel?.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
