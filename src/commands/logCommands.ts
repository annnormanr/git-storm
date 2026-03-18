import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { LogViewProvider } from "../providers/logViewProvider";

export function registerLogCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  logViewProvider: LogViewProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.refreshLog", async () => {
      try {
        await vscode.commands.executeCommand("gitstorm.logView.focus");
        await logViewProvider.refresh();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to refresh log: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.showLog", async () => {
      try {
        await vscode.commands.executeCommand("gitstorm.logView.focus");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to show log: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "gitstorm.cherryPick",
      async (hash: string) => {
        try {
          if (!hash) {
            hash = (await promptForHash("Cherry-pick which commit?")) ?? "";
            if (!hash) {
              return;
            }
          }

          const confirm = await vscode.window.showWarningMessage(
            `Cherry-pick commit ${hash.substring(0, 8)}?`,
            { modal: true },
            "Cherry-Pick",
          );
          if (confirm !== "Cherry-Pick") {
            return;
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Cherry-picking…",
              cancellable: false,
            },
            async () => {
              const output = await gitService.cherryPick(hash);
              vscode.window.showInformationMessage(
                `Cherry-pick successful: ${output.trim() || hash.substring(0, 8)}`,
              );
              await vscode.commands.executeCommand("gitstorm.refreshLog");
            },
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Cherry-pick failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.revertCommit",
      async (hash: string) => {
        try {
          if (!hash) {
            hash = (await promptForHash("Revert which commit?")) ?? "";
            if (!hash) {
              return;
            }
          }

          const confirm = await vscode.window.showWarningMessage(
            `Revert commit ${hash.substring(0, 8)}?`,
            { modal: true },
            "Revert",
          );
          if (confirm !== "Revert") {
            return;
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Reverting commit…",
              cancellable: false,
            },
            async () => {
              const output = await gitService.revertCommit(hash);
              vscode.window.showInformationMessage(
                `Revert successful: ${output.trim() || hash.substring(0, 8)}`,
              );
              await vscode.commands.executeCommand("gitstorm.refreshLog");
            },
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Revert failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.resetToCommit",
      async (hash: string) => {
        try {
          if (!hash) {
            hash = (await promptForHash("Reset to which commit?")) ?? "";
            if (!hash) {
              return;
            }
          }

          const mode = await vscode.window.showQuickPick(
            [
              {
                label: "Soft",
                description: "Keep changes staged",
                value: "soft" as const,
              },
              {
                label: "Mixed",
                description: "Keep changes unstaged (default)",
                value: "mixed" as const,
              },
              {
                label: "Hard",
                description: "Discard all changes (destructive!)",
                value: "hard" as const,
              },
            ],
            {
              placeHolder: "Select reset mode",
              title: `Reset to ${hash.substring(0, 8)}`,
            },
          );
          if (!mode) {
            return;
          }

          if (mode.value === "hard") {
            const confirm = await vscode.window.showWarningMessage(
              `This will DISCARD all changes since ${hash.substring(0, 8)}. This cannot be undone. Continue?`,
              { modal: true },
              "Reset Hard",
            );
            if (confirm !== "Reset Hard") {
              return;
            }
          }

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Resetting (${mode.value})…`,
              cancellable: false,
            },
            async () => {
              await gitService.resetToCommit(hash, mode.value);
              vscode.window.showInformationMessage(
                `Reset (${mode.value}) to ${hash.substring(0, 8)} complete.`,
              );
              await vscode.commands.executeCommand("gitstorm.refreshLog");
            },
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Reset failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.tagCommit",
      async (hash: string) => {
        try {
          if (!hash) {
            hash = (await promptForHash("Tag which commit?")) ?? "";
            if (!hash) {
              return;
            }
          }

          const tagName = await vscode.window.showInputBox({
            prompt: "Tag name",
            placeHolder: "v1.0.0",
            validateInput: (v) => (v.trim() ? null : "Tag name is required"),
          });
          if (!tagName) {
            return;
          }

          const message = await vscode.window.showInputBox({
            prompt: "Tag message (leave empty for lightweight tag)",
            placeHolder: "Release v1.0.0",
          });

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Creating tag…",
              cancellable: false,
            },
            async () => {
              await gitService.createTag(
                tagName.trim(),
                hash,
                message?.trim() || undefined,
              );
              vscode.window.showInformationMessage(
                `Tag "${tagName.trim()}" created on ${hash.substring(0, 8)}.`,
              );
              await vscode.commands.executeCommand("gitstorm.refreshLog");
            },
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to create tag: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.copyCommitHash",
      async (hash: string) => {
        try {
          if (!hash) {
            hash = (await promptForHash("Copy which commit hash?")) ?? "";
            if (!hash) {
              return;
            }
          }

          await vscode.env.clipboard.writeText(hash);
          vscode.window.showInformationMessage(
            `Copied ${hash.substring(0, 8)} to clipboard.`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to copy hash: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ),
  );
}

async function promptForHash(prompt: string): Promise<string | undefined> {
  const raw = await vscode.window.showInputBox({
    prompt,
    placeHolder: "Commit hash",
    validateInput: (v) =>
      /^[0-9a-f]{4,40}$/i.test(v.trim()) ? null : "Enter a valid commit hash",
  });
  return raw?.trim();
}
