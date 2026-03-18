import * as vscode from "vscode";
import { GitService, StashEntry } from "../services/gitService";

export function registerStashCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.stashChanges", async () => {
      try {
        const message = await vscode.window.showInputBox({
          prompt: "Stash message (optional)",
          placeHolder: "WIP: describe your work-in-progress",
        });
        if (message === undefined) {
          return;
        }

        const includeUntracked = await vscode.window.showQuickPick(
          [
            { label: "Tracked files only", value: false },
            { label: "Include untracked files", value: true },
          ],
          { placeHolder: "What to stash?" },
        );
        if (!includeUntracked) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Stashing changes…",
            cancellable: false,
          },
          () =>
            gitService.stash(
              message.trim() || undefined,
              includeUntracked.value,
            ),
        );

        vscode.window.showInformationMessage("Changes stashed.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to stash: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.popStash", async () => {
      try {
        const entry = await pickStash(gitService, "Select stash to pop");
        if (entry === undefined) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Popping stash…",
            cancellable: false,
          },
          () => gitService.stashPop(entry.index),
        );

        vscode.window.showInformationMessage(`Stash@{${entry.index}} popped.`);
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to pop stash: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.applyStash", async () => {
      try {
        const entry = await pickStash(gitService, "Select stash to apply");
        if (entry === undefined) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Applying stash…",
            cancellable: false,
          },
          () => gitService.stashApply(entry.index),
        );

        vscode.window.showInformationMessage(`Stash@{${entry.index}} applied.`);
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to apply stash: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.dropStash", async () => {
      try {
        const entry = await pickStash(gitService, "Select stash to drop");
        if (entry === undefined) {
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          `Drop stash@{${entry.index}} ("${entry.message}")? This cannot be undone.`,
          { modal: true },
          "Drop",
        );
        if (confirm !== "Drop") {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Dropping stash…",
            cancellable: false,
          },
          () => gitService.stashDrop(entry.index),
        );

        vscode.window.showInformationMessage(`Stash@{${entry.index}} dropped.`);
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to drop stash: ${errMsg(err)}`);
      }
    }),
  );
}

async function pickStash(
  gitService: GitService,
  placeHolder: string,
): Promise<StashEntry | undefined> {
  const stashes = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Loading stashes…",
    },
    () => gitService.getStashes(),
  );

  if (stashes.length === 0) {
    vscode.window.showInformationMessage("No stashes found.");
    return undefined;
  }

  const picked = await vscode.window.showQuickPick(
    stashes.map((s) => ({
      label: `stash@{${s.index}}`,
      description: s.message,
      detail: `${s.branch} — ${s.date.toLocaleDateString()}`,
      entry: s,
    })),
    { placeHolder },
  );

  return picked?.entry;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
