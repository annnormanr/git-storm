import * as vscode from "vscode";
import { GitService, StashEntry, FileChange } from "../services/gitService";

export enum StashItemKind {
  Stash = "stash",
  File = "file",
}

export class StashItem extends vscode.TreeItem {
  constructor(
    public readonly kind: StashItemKind,
    public readonly stashEntry?: StashEntry,
    public readonly fileChange?: FileChange,
    public readonly stashIndex?: number,
  ) {
    super("", vscode.TreeItemCollapsibleState.None);

    if (kind === StashItemKind.Stash && stashEntry) {
      this.label = `stash@{${stashEntry.index}}`;
      this.description = stashEntry.message;
      this.tooltip = new vscode.MarkdownString();
      this.tooltip.appendMarkdown(`**stash@{${stashEntry.index}}**\n\n`);
      this.tooltip.appendMarkdown(`${stashEntry.message}\n\n`);
      this.tooltip.appendMarkdown(`Branch: \`${stashEntry.branch}\`\n\n`);
      this.tooltip.appendMarkdown(`Date: ${stashEntry.date.toLocaleString()}`);
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      this.contextValue = "stashEntry";
      this.iconPath = new vscode.ThemeIcon("archive");
    } else if (kind === StashItemKind.File && fileChange) {
      this.label = fileChange.path;
      this.contextValue = "stashFile";

      const statusIcons: Record<string, vscode.ThemeIcon> = {
        A: new vscode.ThemeIcon(
          "diff-added",
          new vscode.ThemeColor("charts.green"),
        ),
        M: new vscode.ThemeIcon(
          "diff-modified",
          new vscode.ThemeColor("charts.blue"),
        ),
        D: new vscode.ThemeIcon(
          "diff-removed",
          new vscode.ThemeColor("charts.red"),
        ),
        R: new vscode.ThemeIcon(
          "diff-renamed",
          new vscode.ThemeColor("charts.orange"),
        ),
      };
      this.iconPath =
        statusIcons[fileChange.status] ?? new vscode.ThemeIcon("file");
    }
  }
}

export class StashTreeProvider implements vscode.TreeDataProvider<StashItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    StashItem | undefined
  >();
  public readonly onDidChangeTreeData: vscode.Event<StashItem | undefined> =
    this._onDidChangeTreeData.event;

  private stashes: StashEntry[] = [];

  constructor(private readonly gitService: GitService) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: StashItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: StashItem): Promise<StashItem[]> {
    if (!element) {
      try {
        this.stashes = await this.gitService.getStashes();
      } catch {
        this.stashes = [];
      }

      return this.stashes.map((s) => new StashItem(StashItemKind.Stash, s));
    }

    if (element.kind === StashItemKind.Stash && element.stashEntry) {
      try {
        const files = await this.gitService.getStashFiles(
          element.stashEntry.index,
        );
        return files.map(
          (f) =>
            new StashItem(
              StashItemKind.File,
              undefined,
              f,
              element.stashEntry!.index,
            ),
        );
      } catch {
        return [];
      }
    }

    return [];
  }

  public async applyStash(item: StashItem): Promise<void> {
    if (!item.stashEntry) {
      return;
    }
    try {
      await this.gitService.stashApply(item.stashEntry.index);
      vscode.window.showInformationMessage(
        `Applied stash@{${item.stashEntry.index}}`,
      );
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async popStash(item: StashItem): Promise<void> {
    if (!item.stashEntry) {
      return;
    }
    try {
      await this.gitService.stashPop(item.stashEntry.index);
      vscode.window.showInformationMessage(
        `Popped stash@{${item.stashEntry.index}}`,
      );
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Pop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async dropStash(item: StashItem): Promise<void> {
    if (!item.stashEntry) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Drop stash@{${item.stashEntry.index}}?`,
      { modal: true },
      "Drop",
    );
    if (confirm !== "Drop") {
      return;
    }
    try {
      await this.gitService.stashDrop(item.stashEntry.index);
      vscode.window.showInformationMessage(
        `Dropped stash@{${item.stashEntry.index}}`,
      );
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Drop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async showStashDiff(item: StashItem): Promise<void> {
    if (
      item.kind === StashItemKind.File &&
      item.fileChange &&
      item.stashIndex !== undefined
    ) {
      const ref = `stash@{${item.stashIndex}}`;
      const parentRef = `${ref}^`;
      const filePath = item.fileChange.path;
      const left = vscode.Uri.from({
        scheme: "gitstorm-diff",
        path: filePath,
        query: `ref=${parentRef}`,
      });
      const right = vscode.Uri.from({
        scheme: "gitstorm-diff",
        path: filePath,
        query: `ref=${ref}`,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${filePath} (stash@{${item.stashIndex}})`,
      );
    } else if (item.kind === StashItemKind.Stash && item.stashEntry) {
      const ref = `stash@{${item.stashEntry.index}}`;
      const parentRef = `${ref}^`;
      const left = vscode.Uri.from({
        scheme: "gitstorm-diff",
        path: "/",
        query: `ref=${parentRef}`,
      });
      const right = vscode.Uri.from({
        scheme: "gitstorm-diff",
        path: "/",
        query: `ref=${ref}`,
      });
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `stash@{${item.stashEntry.index}}`,
      );
    }
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
