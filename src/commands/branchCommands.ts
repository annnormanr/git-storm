import * as vscode from "vscode";
import { GitService, BranchInfo } from "../services/gitService";

export function registerBranchCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.createBranch", async () => {
      try {
        const name = await vscode.window.showInputBox({
          prompt: "New branch name",
          placeHolder: "feature/my-branch",
          validateInput: (v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              return "Branch name is required";
            }
            if (/\s/.test(trimmed)) {
              return "Branch name cannot contain spaces";
            }
            return null;
          },
        });
        if (!name) {
          return;
        }

        const startPoint = await vscode.window.showInputBox({
          prompt: "Start point (branch, tag, or commit — leave empty for HEAD)",
          placeHolder: "HEAD",
        });

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Creating branch "${name.trim()}"…`,
          },
          async () => {
            await gitService.createBranch(
              name.trim(),
              startPoint?.trim() || undefined,
            );
          },
        );

        vscode.window.showInformationMessage(
          `Branch "${name.trim()}" created and checked out.`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to create branch: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.checkoutBranch", async () => {
      try {
        const branches = await gitService.getBranches();
        const items = toBranchQuickPick(branches);

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select branch to checkout",
        });
        if (!picked) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Checking out "${picked.branchName}"…`,
          },
          async () => {
            await gitService.checkoutBranch(picked.branchName);
          },
        );

        vscode.window.showInformationMessage(
          `Switched to branch "${picked.branchName}".`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to checkout branch: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.mergeBranch", async () => {
      try {
        const branches = await gitService.getBranches();
        const currentBranch = await gitService.getCurrentBranch();
        const items = toBranchQuickPick(
          branches.filter((b) => b.name !== currentBranch),
        );

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Select branch to merge into "${currentBranch}"`,
        });
        if (!picked) {
          return;
        }

        const noFfOption = await vscode.window.showQuickPick(
          [
            {
              label: "Default merge",
              description: "Allow fast-forward if possible",
              noFf: false,
            },
            {
              label: "No fast-forward",
              description: "Always create a merge commit",
              noFf: true,
            },
          ],
          { placeHolder: "Merge strategy" },
        );
        if (!noFfOption) {
          return;
        }

        const output = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Merging "${picked.branchName}"…`,
            cancellable: false,
          },
          () => gitService.mergeBranch(picked.branchName, noFfOption.noFf),
        );

        vscode.window.showInformationMessage(
          `Merge complete: ${output.trim().split("\n")[0]}`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Merge failed: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.rebaseBranch", async () => {
      try {
        const branches = await gitService.getBranches();
        const currentBranch = await gitService.getCurrentBranch();
        const items = toBranchQuickPick(
          branches.filter((b) => b.name !== currentBranch),
        );

        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: `Select branch to rebase "${currentBranch}" onto`,
        });
        if (!picked) {
          return;
        }

        const output = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Rebasing onto "${picked.branchName}"…`,
            cancellable: false,
          },
          () => gitService.rebaseBranch(picked.branchName),
        );

        vscode.window.showInformationMessage(
          `Rebase complete: ${output.trim().split("\n")[0]}`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Rebase failed: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.deleteBranch", async () => {
      try {
        const branches = await gitService.getBranches();
        const currentBranch = await gitService.getCurrentBranch();
        const deletable = branches.filter(
          (b) => !b.current && !b.remote && b.name !== currentBranch,
        );

        if (deletable.length === 0) {
          vscode.window.showInformationMessage(
            "No local branches available to delete.",
          );
          return;
        }

        const items = toBranchQuickPick(deletable);
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: "Select branch to delete",
        });
        if (!picked) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Delete branch "${picked.branchName}"?`,
          { modal: true },
          "Delete",
          "Force Delete",
        );
        if (!confirm) {
          return;
        }

        const force = confirm === "Force Delete";

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Deleting "${picked.branchName}"…`,
          },
          () => gitService.deleteBranch(picked.branchName, force),
        );

        vscode.window.showInformationMessage(
          `Branch "${picked.branchName}" deleted.`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to delete branch: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.compareBranches", async () => {
      try {
        const branches = await gitService.getBranches();
        const items = toBranchQuickPick(branches);

        const first = await vscode.window.showQuickPick(items, {
          placeHolder: "Select first branch (base)",
        });
        if (!first) {
          return;
        }

        const second = await vscode.window.showQuickPick(
          toBranchQuickPick(
            branches.filter((b) => b.name !== first.branchName),
          ),
          { placeHolder: "Select second branch (compare)" },
        );
        if (!second) {
          return;
        }

        const diffs = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Computing diff…",
          },
          () => gitService.getDiffBetween(first.branchName, second.branchName),
        );

        if (diffs.length === 0) {
          vscode.window.showInformationMessage(
            `No differences between "${first.branchName}" and "${second.branchName}".`,
          );
          return;
        }

        const fileItems = diffs.map((d) => ({
          label: `$(diff) ${d.newPath}`,
          description: d.status,
          filePath: d.newPath,
        }));

        const pickedFile = await vscode.window.showQuickPick(fileItems, {
          placeHolder: `${diffs.length} file(s) changed — select to view diff`,
        });
        if (!pickedFile) {
          return;
        }

        const leftUri = vscode.Uri.parse(
          `${GIT_BRANCH_SCHEME}:${pickedFile.filePath}`,
        ).with({
          query: JSON.stringify({
            ref: first.branchName,
            filePath: pickedFile.filePath,
          }),
        });
        const rightUri = vscode.Uri.parse(
          `${GIT_BRANCH_SCHEME}:${pickedFile.filePath}`,
        ).with({
          query: JSON.stringify({
            ref: second.branchName,
            filePath: pickedFile.filePath,
          }),
        });

        await vscode.commands.executeCommand(
          "vscode.diff",
          leftUri,
          rightUri,
          `${pickedFile.filePath} (${first.branchName} ↔ ${second.branchName})`,
        );
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to compare branches: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.interactiveRebase", async () => {
      try {
        const commits = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Loading commits…",
          },
          () => gitService.getLog({ maxCount: 50 }),
        );

        if (commits.length === 0) {
          vscode.window.showInformationMessage("No commits to rebase.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          commits.map((c) => ({
            label: c.abbreviatedHash,
            description: c.subject,
            detail: `${c.author} — ${c.authorDate.toLocaleDateString()}`,
            hash: c.hash,
          })),
          {
            placeHolder:
              "Select the base commit (rebase will apply commits after this one)",
          },
        );
        if (!picked) {
          return;
        }

        const repoRoot = await gitService.getRepoRoot();
        const terminalName = "GitStorm Interactive Rebase";
        const terminal = vscode.window.createTerminal({
          name: terminalName,
          cwd: repoRoot,
        });
        terminal.show();
        terminal.sendText(`git rebase -i ${picked.hash}`);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to start interactive rebase: ${errMsg(err)}`,
        );
      }
    }),
  );

  const branchRevProvider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
      const params = JSON.parse(uri.query) as { ref: string; filePath: string };
      const repoRoot = await gitService.getRepoRoot();
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        "git",
        ["--no-pager", "show", `${params.ref}:${params.filePath}`],
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
      GIT_BRANCH_SCHEME,
      branchRevProvider,
    ),
  );
}

const GIT_BRANCH_SCHEME = "gitstorm-branch";

interface BranchQuickPickItem extends vscode.QuickPickItem {
  branchName: string;
}

function toBranchQuickPick(branches: BranchInfo[]): BranchQuickPickItem[] {
  return branches.map((b) => ({
    label: b.current ? `$(star) ${b.name}` : b.name,
    description: [
      b.remote ? "remote" : "local",
      b.ahead > 0 ? `↑${b.ahead}` : "",
      b.behind > 0 ? `↓${b.behind}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    detail: b.lastCommitMessage,
    branchName: b.name,
  }));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
