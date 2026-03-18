import * as vscode from "vscode";
import * as path from "path";
import { GitService } from "../services/gitService";
import { BlameProvider } from "../providers/blameProvider";
import { FileHistoryProvider } from "../providers/fileHistoryProvider";

const GIT_REVISION_SCHEME = "gitstorm-rev";

class GitRevisionContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private gitService: GitService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = JSON.parse(uri.query) as { ref: string; filePath: string };
    const repoRoot = await this.gitService.getRepoRoot();
    const relativePath = path
      .relative(repoRoot, params.filePath)
      .replace(/\\/g, "/");
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "show", `${params.ref}:${relativePath}`],
      {
        cwd: repoRoot,
        maxBuffer: 50 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return stdout;
  }
}

export function registerFileCommands(
  context: vscode.ExtensionContext,
  gitService: GitService,
  blameProvider: BlameProvider,
  fileHistoryProvider: FileHistoryProvider,
): void {
  const revisionProvider = new GitRevisionContentProvider(gitService);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      GIT_REVISION_SCHEME,
      revisionProvider,
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gitstorm.showFileHistory",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }
          await fileHistoryProvider.showFileHistory(uri);
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to show file history: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.annotateFile",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }
          await blameProvider.toggleFileAnnotations(uri);
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to annotate file: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.compareWithBranch",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }

          const branches = await gitService.getBranches();
          const picked = await vscode.window.showQuickPick(
            branches.map((b) => ({
              label: b.current ? `$(star) ${b.name}` : b.name,
              description: b.remote ? "remote" : "local",
              branch: b.name,
            })),
            { placeHolder: "Select branch to compare with" },
          );
          if (!picked) {
            return;
          }

          const revUri = buildRevisionUri(picked.branch, uri.fsPath);
          const fileName = path.basename(uri.fsPath);
          await vscode.commands.executeCommand(
            "vscode.diff",
            revUri,
            uri,
            `${fileName} (${picked.branch} ↔ Working Copy)`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to compare with branch: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.compareWithRevision",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }

          const repoRoot = await gitService.getRepoRoot();
          const relativePath = path
            .relative(repoRoot, uri.fsPath)
            .replace(/\\/g, "/");
          const commits = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Loading file history…",
            },
            () => gitService.getFileHistory(relativePath, 50),
          );

          if (commits.length === 0) {
            vscode.window.showInformationMessage(
              "No history found for this file.",
            );
            return;
          }

          const picked = await vscode.window.showQuickPick(
            commits.map((c) => ({
              label: c.abbreviatedHash,
              description: c.subject,
              detail: `${c.author} — ${c.authorDate.toLocaleDateString()}`,
              hash: c.hash,
            })),
            { placeHolder: "Select revision to compare with" },
          );
          if (!picked) {
            return;
          }

          const revUri = buildRevisionUri(picked.hash, uri.fsPath);
          const fileName = path.basename(uri.fsPath);
          await vscode.commands.executeCommand(
            "vscode.diff",
            revUri,
            uri,
            `${fileName} (${picked.label} ↔ Working Copy)`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to compare with revision: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.showDiff",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }

          const headUri = buildRevisionUri("HEAD", uri.fsPath);
          const fileName = path.basename(uri.fsPath);
          await vscode.commands.executeCommand(
            "vscode.diff",
            headUri,
            uri,
            `${fileName} (HEAD ↔ Working Copy)`,
          );
        } catch (err: unknown) {
          vscode.window.showErrorMessage(`Failed to show diff: ${errMsg(err)}`);
        }
      },
    ),

    vscode.commands.registerCommand(
      "gitstorm.rollbackFile",
      async (uri?: vscode.Uri) => {
        try {
          uri = uri ?? vscode.window.activeTextEditor?.document.uri;
          if (!uri) {
            vscode.window.showWarningMessage("No file selected.");
            return;
          }

          const fileName = path.basename(uri.fsPath);
          const confirm = await vscode.window.showWarningMessage(
            `Revert "${fileName}" to HEAD? All unsaved changes will be lost.`,
            { modal: true },
            "Rollback",
          );
          if (confirm !== "Rollback") {
            return;
          }

          const repoRoot = await gitService.getRepoRoot();
          const relativePath = path
            .relative(repoRoot, uri.fsPath)
            .replace(/\\/g, "/");

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `Rolling back ${fileName}…`,
            },
            async () => {
              const { execFile } = await import("child_process");
              const { promisify } = await import("util");
              const execFileAsync = promisify(execFile);
              await execFileAsync(
                "git",
                ["--no-pager", "checkout", "HEAD", "--", relativePath],
                {
                  cwd: repoRoot,
                  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
                },
              );
            },
          );

          vscode.window.showInformationMessage(
            `"${fileName}" reverted to HEAD.`,
          );
          await vscode.commands.executeCommand("gitstorm.refreshLog");
        } catch (err: unknown) {
          vscode.window.showErrorMessage(
            `Failed to rollback file: ${errMsg(err)}`,
          );
        }
      },
    ),

    vscode.commands.registerCommand("gitstorm.toggleAnnotations", async () => {
      try {
        await blameProvider.toggleInlineAnnotations();
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Failed to toggle annotations: ${errMsg(err)}`,
        );
      }
    }),

    vscode.commands.registerCommand("gitstorm.partialCommit", async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage("No active editor.");
          return;
        }

        const selection = editor.selection;
        if (selection.isEmpty) {
          vscode.window.showWarningMessage("Select lines to commit first.");
          return;
        }

        const uri = editor.document.uri;
        const repoRoot = await gitService.getRepoRoot();
        const relativePath = path
          .relative(repoRoot, uri.fsPath)
          .replace(/\\/g, "/");

        const diffs = await gitService.getDiff(relativePath);
        if (diffs.length === 0) {
          vscode.window.showInformationMessage(
            "No changes to commit for this file.",
          );
          return;
        }

        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;

        let patchContent = "";
        for (const fileDiff of diffs) {
          let fileHeaderEmitted = false;
          for (const hunk of fileDiff.hunks) {
            const filteredLines = hunk.lines.filter((line) => {
              if (line.type === "context") {
                return true;
              }
              const lineNum = line.newLineNumber ?? line.oldLineNumber ?? 0;
              return lineNum >= startLine && lineNum <= endLine;
            });

            if (filteredLines.some((l) => l.type !== "context")) {
              // Strip leading and trailing pure-context lines to avoid
              // misaligned start offsets and extraneous context
              let first = 0;
              while (
                first < filteredLines.length &&
                filteredLines[first].type === "context"
              ) {
                first++;
              }
              let last = filteredLines.length - 1;
              while (last > first && filteredLines[last].type === "context") {
                last--;
              }
              // Keep up to 3 context lines around changes
              const ctxBefore = Math.min(first, 3);
              const ctxAfter = Math.min(filteredLines.length - 1 - last, 3);
              const trimmed = filteredLines.slice(
                first - ctxBefore,
                last + 1 + ctxAfter,
              );

              if (trimmed.length === 0) {
                continue;
              }

              let oldLines = 0;
              let newLines = 0;
              for (const line of trimmed) {
                if (line.type === "context") {
                  oldLines++;
                  newLines++;
                } else if (line.type === "add") {
                  newLines++;
                } else if (line.type === "delete") {
                  oldLines++;
                }
              }

              // Compute adjusted start from the first line in trimmed set
              const firstLine = trimmed[0];
              const adjOldStart = firstLine.oldLineNumber ?? hunk.oldStart;
              const adjNewStart = firstLine.newLineNumber ?? hunk.newStart;

              if (!fileHeaderEmitted) {
                patchContent += `--- a/${fileDiff.oldPath}\n`;
                patchContent += `+++ b/${fileDiff.newPath}\n`;
                fileHeaderEmitted = true;
              }
              patchContent += `@@ -${adjOldStart},${oldLines} +${adjNewStart},${newLines} @@ ${hunk.header}\n`;
              for (const line of trimmed) {
                switch (line.type) {
                  case "context":
                    patchContent += ` ${line.content}\n`;
                    break;
                  case "add":
                    patchContent += `+${line.content}\n`;
                    break;
                  case "delete":
                    patchContent += `-${line.content}\n`;
                    break;
                }
              }
            }
          }
        }

        if (!patchContent) {
          vscode.window.showInformationMessage(
            "No changed lines in the selected range.",
          );
          return;
        }

        const message = await vscode.window.showInputBox({
          prompt: "Commit message for selected lines",
          placeHolder: "Describe this change",
          validateInput: (v) =>
            v.trim() ? null : "Commit message is required",
        });
        if (!message) {
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Committing selected lines…",
          },
          async () => {
            await gitService.stageLines(relativePath, patchContent);

            const { execFile } = await import("child_process");
            const { promisify } = await import("util");
            const execFileAsync = promisify(execFile);
            await execFileAsync(
              "git",
              ["--no-pager", "commit", "-m", message.trim()],
              {
                cwd: repoRoot,
                env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
              },
            );
          },
        );

        vscode.window.showInformationMessage("Partial commit created.");
        await vscode.commands.executeCommand("gitstorm.refreshLog");
      } catch (err: unknown) {
        vscode.window.showErrorMessage(`Partial commit failed: ${errMsg(err)}`);
      }
    }),
  );
}

function buildRevisionUri(ref: string, filePath: string): vscode.Uri {
  const query = JSON.stringify({ ref, filePath });
  return vscode.Uri.parse(
    `${GIT_REVISION_SCHEME}:${path.basename(filePath)}`,
  ).with({ query });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
