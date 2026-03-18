import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { MergeConflictProvider } from "../providers/mergeConflictProvider";

export function registerMergeCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  mergeConflictProvider: MergeConflictProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.resolveConflicts", async () => {
      try {
        const conflicts = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Detecting merge conflicts…",
          },
          () => gitService.getMergeConflicts(),
        );

        if (conflicts.length === 0) {
          vscode.window.showInformationMessage("No merge conflicts detected.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          conflicts.map((c) => ({
            label: `$(warning) ${c.path}`,
            description: "conflict",
            conflictPath: c.path,
          })),
          {
            placeHolder: `${conflicts.length} conflict(s) found — select file to resolve`,
            canPickMany: false,
          },
        );
        if (!picked) {
          return;
        }

        const conflict = conflicts.find((c) => c.path === picked.conflictPath)!;
        mergeConflictProvider.openMergeTool(conflict);
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to resolve conflicts: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.abortMerge", async () => {
      try {
        const confirm = await vscode.window.showWarningMessage(
          "Abort the current merge? Uncommitted merge changes will be lost.",
          { modal: true },
          "Abort Merge",
        );
        if (confirm !== "Abort Merge") {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Aborting merge…",
          },
          () => gitService.abortMerge(),
        );

        vscode.window.showInformationMessage("Merge aborted.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to abort merge: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.continueMerge", async () => {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Continuing merge…",
          },
          () => gitService.continueMerge(),
        );

        vscode.window.showInformationMessage("Merge continued successfully.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to continue merge: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.abortRebase", async () => {
      try {
        const status = await gitService.getRebaseStatus();
        if (!status.inProgress) {
          vscode.window.showInformationMessage("No rebase in progress.");
          return;
        }

        const confirm = await vscode.window.showWarningMessage(
          "Abort the current rebase? This will restore the branch to its state before the rebase.",
          { modal: true },
          "Abort Rebase",
        );
        if (confirm !== "Abort Rebase") {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Aborting rebase…",
          },
          () => gitService.abortRebase(),
        );

        vscode.window.showInformationMessage("Rebase aborted.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to abort rebase: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.continueRebase", async () => {
      try {
        const status = await gitService.getRebaseStatus();
        if (!status.inProgress) {
          vscode.window.showInformationMessage("No rebase in progress.");
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title:
              status.currentStep && status.totalSteps
                ? `Continuing rebase (step ${status.currentStep}/${status.totalSteps})…`
                : "Continuing rebase…",
          },
          () => gitService.continueRebase(),
        );

        vscode.window.showInformationMessage("Rebase step completed.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to continue rebase: ${errMsg(err)}`,
        );
      }
    }),
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
