import * as vscode from "vscode";
import { GitService } from "../services/gitService";
import { ChangelistManager } from "../services/changelistManager";
import { ShelveManager } from "../services/shelveManager";

export function registerChangelistCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  changelistManager: ChangelistManager,
  shelveManager: ShelveManager,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstorm.createChangelist", async () => {
      try {
        const name = await vscode.window.showInputBox({
          prompt: "Changelist name",
          placeHolder: "My Changelist",
          validateInput: (v) =>
            v.trim() ? null : "Changelist name is required",
        });
        if (!name) {
          return;
        }

        await changelistManager.createChangelist(name.trim());
        vscode.window.showInformationMessage(
          `Changelist "${name.trim()}" created.`,
        );
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to create changelist: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand(
      "gitstorm.moveToChangelist",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }

          const changelists = changelistManager.getChangelists();
          if (changelists.length === 0) {
            vscode.window.showInformationMessage(
              "No changelists. Create one first.",
            );
            return;
          }

          const repoRoot = await gitService.getRepoRoot();
          const path = await import("path");
          const relativePath = path
            .relative(repoRoot, uri.fsPath)
            .replace(/\\/g, "/");
          const currentCl =
            changelistManager.getChangelistForFile(relativePath);

          const picked = await vscode.window.showQuickPick(
            changelists.map((cl) => ({
              label: cl.isDefault ? `$(star) ${cl.name}` : cl.name,
              description:
                cl.name === currentCl
                  ? "(current)"
                  : `${cl.files.length} file(s)`,
              clName: cl.name,
            })),
            {
              placeHolder: `Move "${path.basename(uri.fsPath)}" to changelist`,
            },
          );
          if (!picked) {
            return;
          }

          await changelistManager.moveToChangelist(relativePath, picked.clName);
          vscode.window.showInformationMessage(
            `Moved to changelist "${picked.clName}".`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to move to changelist: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand("gitstorm.shelveChanges", async () => {
      try {
        const name = await vscode.window.showInputBox({
          prompt: "Shelved change name",
          placeHolder: "My shelved changes",
          validateInput: (v) => (v.trim() ? null : "Name is required"),
        });
        if (!name) {
          return;
        }

        const status = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Loading changed files…",
          },
          () => gitService.getStatus(),
        );

        if (status.length === 0) {
          vscode.window.showInformationMessage("No changes to shelve.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          status.map((f) => ({
            label: `$(${statusIcon(f.status)}) ${f.path}`,
            description: f.status,
            filePath: f.path,
            picked: true,
          })),
          { placeHolder: "Select files to shelve", canPickMany: true },
        );
        if (!picked || picked.length === 0) {
          return;
        }

        const filePaths = picked.map((p) => p.filePath);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Shelving changes…",
            cancellable: false,
          },
          () => shelveManager.shelve(name.trim(), filePaths, gitService),
        );

        vscode.window.showInformationMessage(
          `Shelved ${filePaths.length} file(s) as "${name.trim()}".`,
        );
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to shelve: ${errMsg(err)}`);
      }
    }),

    vscode.commands.registerCommand("gitstorm.unshelveChanges", async () => {
      try {
        const shelved = shelveManager.getShelvedChanges();
        if (shelved.length === 0) {
          vscode.window.showInformationMessage("No shelved changes.");
          return;
        }

        const picked = await vscode.window.showQuickPick(
          shelved.map((s) => ({
            label: s.name,
            description: `${s.patches.length} file(s)`,
            detail: s.date.toLocaleString(),
            id: s.id,
          })),
          { placeHolder: "Select shelved change to restore" },
        );
        if (!picked) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Unshelving changes…",
            cancellable: false,
          },
          () => shelveManager.unshelve(picked.id, gitService),
        );

        vscode.window.showInformationMessage(`Unshelved "${picked.label}".`);
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Failed to unshelve: ${errMsg(err)}`);
      }
    }),
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case "A":
      return "diff-added";
    case "M":
      return "diff-modified";
    case "D":
      return "diff-removed";
    case "R":
      return "diff-renamed";
    default:
      return "file";
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
