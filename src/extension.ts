import * as vscode from "vscode";
import { execFile } from "child_process";
import { promisify } from "util";
import { GitService } from "./services/gitService";
import { GitHubService } from "./services/githubService";
import { ChangelistManager } from "./services/changelistManager";
import { ShelveManager } from "./services/shelveManager";
import { LogViewProvider } from "./providers/logViewProvider";
import { BlameProvider } from "./providers/blameProvider";
import { BranchTreeProvider } from "./providers/branchTreeProvider";
import { StashTreeProvider } from "./providers/stashTreeProvider";
import { ChangelistTreeProvider } from "./providers/changelistTreeProvider";
import { FileHistoryProvider } from "./providers/fileHistoryProvider";
import { MergeConflictProvider } from "./providers/mergeConflictProvider";
import { PRViewProvider } from "./providers/prViewProvider";
import { registerBranchCommands } from "./commands/branchCommands";
import { registerFileCommands } from "./commands/fileCommands";
import { registerLogCommands } from "./commands/logCommands";
import { registerMergeCommands } from "./commands/mergeCommands";
import { registerStashCommands } from "./commands/stashCommands";
import { registerChangelistCommands } from "./commands/changelistCommands";
import { registerGitHubCommands } from "./commands/githubCommands";

const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel("GitStorm");
  context.subscriptions.push(outputChannel);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    outputChannel.appendLine(
      "GitStorm: No workspace folder found, extension not activating.",
    );
    return;
  }
  outputChannel.appendLine(`GitStorm: Activating in ${workspaceRoot}`);

  const gitService = new GitService(workspaceRoot);
  const githubService = new GitHubService(workspaceRoot);
  const changelistManager = new ChangelistManager(context);
  const shelveManager = new ShelveManager(context);

  const logViewProvider = new LogViewProvider(
    context.extensionUri,
    gitService,
    outputChannel,
  );
  const blameProvider = new BlameProvider(gitService);
  const branchTreeProvider = new BranchTreeProvider(gitService);
  const stashTreeProvider = new StashTreeProvider(gitService);
  const changelistTreeProvider = new ChangelistTreeProvider(
    changelistManager,
    gitService,
  );
  const fileHistoryProvider = new FileHistoryProvider(
    context.extensionUri,
    gitService,
  );
  const mergeConflictProvider = new MergeConflictProvider(
    context.extensionUri,
    gitService,
  );
  const prViewProvider = new PRViewProvider(
    context.extensionUri,
    githubService,
  );

  // Register gitstorm-diff content provider (used by log, stash, changelist views)
  const diffContentProvider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const ref = decodeURIComponent(uri.query.replace(/^ref=/, ""));
      const rawPath = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
      const filePath = rawPath;
      const repoRoot = await gitService.getRepoRoot();

      if (!filePath || filePath === "") {
        const { stdout } = await execFileAsync(
          "git",
          ["--no-pager", "show", ref],
          {
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );
        return stdout;
      }

      const { stdout } = await execFileAsync(
        "git",
        ["--no-pager", "show", `${ref}:${filePath}`],
        {
          cwd: repoRoot,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      return stdout;
    },
  };

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      "gitstorm-diff",
      diffContentProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      LogViewProvider.viewType,
      logViewProvider,
    ),
    vscode.window.registerWebviewViewProvider(
      PRViewProvider.viewType,
      prViewProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "gitstorm.branches",
      branchTreeProvider,
    ),
    vscode.window.registerTreeDataProvider(
      "gitstorm.stashes",
      stashTreeProvider,
    ),
    vscode.window.createTreeView("gitstorm.changelists", {
      treeDataProvider: changelistTreeProvider,
      dragAndDropController: changelistTreeProvider,
    }),
    blameProvider,
    fileHistoryProvider,
    mergeConflictProvider,
    logViewProvider,
    changelistManager,
    shelveManager,
    branchTreeProvider,
    stashTreeProvider,
    changelistTreeProvider,
    prViewProvider,
  );

  registerBranchCommands(context, gitService);
  registerFileCommands(context, gitService, blameProvider, fileHistoryProvider);
  registerLogCommands(context, gitService, logViewProvider);
  registerMergeCommands(context, gitService, mergeConflictProvider);
  registerStashCommands(context, gitService);
  registerChangelistCommands(
    context,
    gitService,
    changelistManager,
    shelveManager,
  );
  registerGitHubCommands(context, gitService, githubService, prViewProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gitstorm.goToCommit",
      async (hash: string) => {
        await logViewProvider.navigateToCommit(hash);
      },
    ),
  );

  // Tree view item action commands
  context.subscriptions.push(
    // Branch actions
    vscode.commands.registerCommand("gitstorm.tree.checkout", (item) =>
      branchTreeProvider.checkout(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.mergeBranch", (item) =>
      branchTreeProvider.mergeIntoCurrent(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.rebaseBranch", (item) =>
      branchTreeProvider.rebaseOnto(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.deleteBranch", (item) =>
      branchTreeProvider.deleteBranch(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.compareBranch", (item) =>
      branchTreeProvider.compareWithCurrent(item),
    ),
    // Stash actions
    vscode.commands.registerCommand("gitstorm.tree.applyStash", (item) =>
      stashTreeProvider.applyStash(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.popStash", (item) =>
      stashTreeProvider.popStash(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.dropStash", (item) =>
      stashTreeProvider.dropStash(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.showStashDiff", (item) =>
      stashTreeProvider.showStashDiff(item),
    ),
    // Changelist actions
    vscode.commands.registerCommand("gitstorm.tree.createChangelist", () =>
      changelistTreeProvider.createChangelist(),
    ),
    vscode.commands.registerCommand("gitstorm.tree.renameChangelist", (item) =>
      changelistTreeProvider.renameChangelist(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.deleteChangelist", (item) =>
      changelistTreeProvider.deleteChangelist(item),
    ),
    vscode.commands.registerCommand(
      "gitstorm.tree.setDefaultChangelist",
      (item) => changelistTreeProvider.setAsDefault(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.showFileDiff", (item) =>
      changelistTreeProvider.showFileDiff(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.moveFile", (item) =>
      changelistTreeProvider.moveFileToChangelist(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.removeFile", (item) =>
      changelistTreeProvider.removeFileFromChangelist(item),
    ),
    vscode.commands.registerCommand("gitstorm.tree.commitChangelist", (item) =>
      changelistTreeProvider.commitAll(item),
    ),
  );

  const autoRefresh = setInterval(async () => {
    try {
      branchTreeProvider.refresh();
      stashTreeProvider.refresh();
    } catch {
      // ignore background refresh errors
    }
  }, 30_000);

  context.subscriptions.push(
    new vscode.Disposable(() => clearInterval(autoRefresh)),
  );

  const fsWatcher = vscode.workspace.createFileSystemWatcher("**/.git/**");
  const debouncedRefresh = debounce(() => {
    branchTreeProvider.refresh();
    stashTreeProvider.refresh();
  }, 1000);

  context.subscriptions.push(
    fsWatcher,
    fsWatcher.onDidChange(debouncedRefresh),
    fsWatcher.onDidCreate(debouncedRefresh),
    fsWatcher.onDidDelete(debouncedRefresh),
  );
}

export function deactivate(): void {
  // cleanup handled by disposables
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(fn, ms);
  };
}
