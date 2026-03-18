import * as vscode from "vscode";
import { GitHubService } from "../services/githubService";
import { GitService } from "../services/gitService";
import { PRViewProvider } from "../providers/prViewProvider";

export function registerGitHubCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  githubService: GitHubService,
  prViewProvider: PRViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.createPullRequest", async () => {
      try {
        let token = await githubService.getTokenSilent();
        if (!token) {
          try {
            token = await githubService.promptForToken();
          } catch {
            return;
          }
        }

        const currentBranch = await gitService.getCurrentBranch();
        const branches = await gitService.getBranches();
        const localBranches = branches.filter((b) => !b.remote);

        const title = await vscode.window.showInputBox({
          prompt: "Pull request title",
          placeHolder: "Add new feature",
          value: currentBranch.replace(/[-_]/g, " "),
          validateInput: (v) => (v.trim() ? null : "Title is required"),
        });
        if (!title) {
          return;
        }

        const body = await vscode.window.showInputBox({
          prompt: "Pull request description (optional)",
          placeHolder: "Describe the changes…",
        });
        if (body === undefined) {
          return;
        }

        const basePick = await vscode.window.showQuickPick(
          localBranches
            .filter((b) => b.name !== currentBranch)
            .map((b) => ({
              label: b.name,
              description:
                b.name === "main" || b.name === "master" ? "(default)" : "",
              branchName: b.name,
            })),
          { placeHolder: "Select base branch" },
        );
        if (!basePick) {
          return;
        }

        const draftPick = await vscode.window.showQuickPick(
          [
            { label: "Ready for review", draft: false },
            {
              label: "Draft",
              description: "Mark as work-in-progress",
              draft: true,
            },
          ],
          { placeHolder: "PR type" },
        );
        if (!draftPick) {
          return;
        }

        const pr = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Creating pull request…",
            cancellable: false,
          },
          () =>
            githubService.createPullRequest(
              title.trim(),
              body?.trim() ?? "",
              currentBranch,
              basePick.branchName,
              draftPick.draft,
            ),
        );

        const openAction = "Open in Browser";
        const result = await vscode.window.showInformationMessage(
          `Pull request #${pr.number} created.`,
          openAction,
        );
        if (result === openAction) {
          await vscode.env.openExternal(vscode.Uri.parse(pr.url));
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to create pull request: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.viewPullRequests", async () => {
      try {
        prViewProvider.show();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to show pull requests: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.reviewPullRequest", async () => {
      try {
        let token = await githubService.getTokenSilent();
        if (!token) {
          try {
            token = await githubService.promptForToken();
          } catch {
            return;
          }
        }

        const prs = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Loading pull requests…",
          },
          () => githubService.listPullRequests("open"),
        );

        if (prs.length === 0) {
          vscode.window.showInformationMessage("No open pull requests.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          prs.map((pr) => ({
            label: `#${pr.number} ${pr.title}`,
            description: pr.draft ? "(draft)" : "",
            detail: `${pr.author} — ${pr.headBranch} → ${pr.baseBranch}`,
            prNumber: pr.number,
          })),
          { placeHolder: "Select pull request to review" },
        );
        if (!picked) {
          return;
        }

        prViewProvider.showReview(picked.prNumber);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to load pull requests: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.createGist", async () => {
      try {
        let token = await githubService.getTokenSilent();
        if (!token) {
          try {
            token = await githubService.promptForToken();
          } catch {
            return;
          }
        }

        const editor = vscode.window.activeTextEditor;
        let content: string;
        let filename: string;

        if (editor && !editor.selection.isEmpty) {
          content = editor.document.getText(editor.selection);
          const path = await import("path");
          filename = path.basename(editor.document.uri.fsPath);
        } else if (editor) {
          content = editor.document.getText();
          const path = await import("path");
          filename = path.basename(editor.document.uri.fsPath);
        } else {
          vscode.window.showWarningMessage(
            "Open a file or select text to create a gist.",
          );
          return;
        }

        const description = await vscode.window.showInputBox({
          prompt: "Gist description (optional)",
          placeHolder: "Describe this gist",
        });
        if (description === undefined) {
          return;
        }

        const visibility = await vscode.window.showQuickPick(
          [
            {
              label: "Secret",
              description: "Only accessible via URL",
              isPublic: false,
            },
            {
              label: "Public",
              description: "Visible to everyone",
              isPublic: true,
            },
          ],
          { placeHolder: "Gist visibility" },
        );
        if (!visibility) {
          return;
        }

        const url = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Creating gist…",
            cancellable: false,
          },
          () =>
            githubService.createGist(
              description?.trim() ?? "",
              { [filename]: content },
              visibility.isPublic,
            ),
        );

        const openAction = "Open in Browser";
        const copyAction = "Copy URL";
        const result = await vscode.window.showInformationMessage(
          `Gist created: ${url}`,
          openAction,
          copyAction,
        );
        if (result === openAction) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        } else if (result === copyAction) {
          await vscode.env.clipboard.writeText(url);
        }
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to create gist: ${errMsg(err)}`);
      }
    }),
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
