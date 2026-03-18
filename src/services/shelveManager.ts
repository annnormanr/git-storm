import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { GitService } from "./gitService";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface ShelvedChange {
  id: string;
  name: string;
  date: Date;
  patches: { filePath: string; patch: string }[];
}

// ── Storage Format ──────────────────────────────────────────────────────

interface StoredShelvedChange {
  id: string;
  name: string;
  date: string;
  patches: { filePath: string; patch: string }[];
}

const STORAGE_KEY = "gitstorm.shelvedChanges";

// ── Shelve Manager ──────────────────────────────────────────────────────

export class ShelveManager {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {}

  private load(): ShelvedChange[] {
    const raw = this.context.workspaceState.get<StoredShelvedChange[]>(
      STORAGE_KEY,
      [],
    );
    return raw.map((entry) => ({
      ...entry,
      date: new Date(entry.date),
    }));
  }

  private async save(changes: ShelvedChange[]): Promise<void> {
    const toStore: StoredShelvedChange[] = changes.map((c) => ({
      ...c,
      date: c.date.toISOString(),
    }));
    await this.context.workspaceState.update(STORAGE_KEY, toStore);
    this._onDidChange.fire();
  }

  async shelve(
    name: string,
    files: string[],
    gitService: GitService,
  ): Promise<ShelvedChange> {
    const patches: { filePath: string; patch: string }[] = [];

    const repoRoot = await gitService.getRepoRoot();
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    for (const file of files) {
      // Use `git diff HEAD` to capture both staged and unstaged changes as a proper patch
      try {
        const { stdout: patchContent } = await execFileAsync(
          "git",
          ["--no-pager", "diff", "HEAD", "--", file],
          {
            cwd: repoRoot,
            maxBuffer: 50 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        );

        if (patchContent.trim()) {
          patches.push({ filePath: file, patch: patchContent });
        }
      } catch (outerErr: unknown) {
        // Only fall through to untracked-file path if git couldn't resolve HEAD
        // (meaning the file is likely untracked). Other errors should surface.
        const errMessage =
          outerErr instanceof Error ? outerErr.message : String(outerErr);
        const isUntracked =
          errMessage.includes("no such path") ||
          errMessage.includes("unknown revision") ||
          errMessage.includes("bad revision") ||
          errMessage.includes("did not match any file");

        if (!isUntracked) {
          vscode.window.showWarningMessage(
            `GitStorm: Could not shelve "${file}": ${errMessage}`,
          );
          continue;
        }

        // File is untracked; try generating a diff for it
        // git diff --no-index exits 1 when differences exist, so we read stdout from the error
        try {
          const { stdout: patchContent } = await execFileAsync(
            "git",
            ["--no-pager", "diff", "--no-index", "--", "/dev/null", file],
            {
              cwd: repoRoot,
              maxBuffer: 50 * 1024 * 1024,
              env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            },
          );
          if (patchContent.trim()) {
            patches.push({ filePath: file, patch: patchContent });
          }
        } catch (diffErr: unknown) {
          const errObj = diffErr as { stdout?: string };
          const patchFromErr = errObj?.stdout ?? "";
          if (patchFromErr.trim()) {
            patches.push({ filePath: file, patch: patchFromErr });
          }
        }
      }
    }

    if (patches.length === 0) {
      throw new Error("No changes to shelve");
    }

    // Revert the files after capturing patches
    for (const file of files) {
      try {
        await gitService.unstageFile(file);
      } catch {
        /* may not be staged */
      }
      try {
        await execFileAsync("git", ["--no-pager", "checkout", "--", file], {
          cwd: repoRoot,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch {
        // Checkout fails for untracked files — remove them from the working tree
        try {
          await fs.promises.unlink(path.join(repoRoot, file));
        } catch {
          /* file may already be gone */
        }
      }
    }

    const entry: ShelvedChange = {
      id: crypto.randomUUID(),
      name,
      date: new Date(),
      patches,
    };

    const all = this.load();
    all.push(entry);
    await this.save(all);

    return entry;
  }

  async unshelve(id: string, gitService: GitService): Promise<void> {
    const all = this.load();
    const entry = all.find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Shelved change "${id}" not found`);
    }

    for (const { patch } of entry.patches) {
      await gitService.applyPatchToWorkingTree(patch);
    }

    // Remove from storage after successful apply
    const remaining = all.filter((e) => e.id !== id);
    await this.save(remaining);
  }

  getShelvedChanges(): ShelvedChange[] {
    return this.load();
  }

  async deleteShelvedChange(id: string): Promise<void> {
    const all = this.load();
    const remaining = all.filter((e) => e.id !== id);
    if (remaining.length === all.length) {
      throw new Error(`Shelved change "${id}" not found`);
    }
    await this.save(remaining);
  }

  peekShelvedChange(id: string): ShelvedChange | undefined {
    return this.load().find((e) => e.id === id);
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
