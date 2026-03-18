import * as vscode from "vscode";
import { ChangelistManager, Changelist } from "../services/changelistManager";
import { GitService } from "../services/gitService";

export enum ChangelistItemKind {
  Changelist = "changelist",
  File = "file",
}

export class ChangelistItem extends vscode.TreeItem {
  constructor(
    public readonly kind: ChangelistItemKind,
    public readonly changelistName: string,
    public readonly filePath?: string,
    isDefault?: boolean,
    fileCount?: number,
    repoRoot?: string,
  ) {
    super("", vscode.TreeItemCollapsibleState.None);

    if (kind === ChangelistItemKind.Changelist) {
      this.label = changelistName;
      this.description = `${fileCount ?? 0} file(s)`;
      this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      this.contextValue = isDefault ? "defaultChangelist" : "changelist";
      this.iconPath = isDefault
        ? new vscode.ThemeIcon(
            "star-full",
            new vscode.ThemeColor("charts.yellow"),
          )
        : new vscode.ThemeIcon("list-unordered");
    } else if (filePath) {
      this.label = filePath.split("/").pop() ?? filePath;
      this.description = filePath.includes("/")
        ? filePath.substring(0, filePath.lastIndexOf("/"))
        : "";
      this.contextValue = "changelistFile";
      this.iconPath = new vscode.ThemeIcon("file");
      const fileUri = repoRoot
        ? vscode.Uri.joinPath(vscode.Uri.file(repoRoot), filePath)
        : vscode.Uri.file(filePath);
      this.resourceUri = fileUri;
      this.command = {
        command: "vscode.open",
        title: "Open File",
        arguments: [fileUri],
      };
    }
  }
}

const CHANGELIST_MIME = "application/vnd.gitstorm.changelist-file";

export class ChangelistTreeProvider
  implements
    vscode.TreeDataProvider<ChangelistItem>,
    vscode.TreeDragAndDropController<ChangelistItem>
{
  public readonly dropMimeTypes = [CHANGELIST_MIME];
  public readonly dragMimeTypes = [CHANGELIST_MIME];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ChangelistItem | undefined
  >();
  public readonly onDidChangeTreeData: vscode.Event<
    ChangelistItem | undefined
  > = this._onDidChangeTreeData.event;

  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly changelistManager: ChangelistManager,
    private readonly gitService: GitService,
  ) {
    this.disposables.push(changelistManager.onDidChange(() => this.refresh()));
  }

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: ChangelistItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(
    element?: ChangelistItem,
  ): Promise<ChangelistItem[]> {
    if (!element) {
      const changelists = this.changelistManager.getChangelists();
      return changelists.map(
        (cl) =>
          new ChangelistItem(
            ChangelistItemKind.Changelist,
            cl.name,
            undefined,
            cl.isDefault,
            cl.files.length,
          ),
      );
    }

    if (element.kind === ChangelistItemKind.Changelist) {
      const changelists = this.changelistManager.getChangelists();
      const cl = changelists.find((c) => c.name === element.changelistName);
      if (!cl) {
        return [];
      }

      let repoRoot: string | undefined;
      try {
        repoRoot = await this.gitService.getRepoRoot();
      } catch {
        // fallback: relative paths
      }

      return cl.files.map(
        (f) =>
          new ChangelistItem(
            ChangelistItemKind.File,
            element.changelistName,
            f,
            undefined,
            undefined,
            repoRoot,
          ),
      );
    }

    return [];
  }

  // Drag and drop support

  public handleDrag(
    source: readonly ChangelistItem[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const files = source
      .filter((item) => item.kind === ChangelistItemKind.File && item.filePath)
      .map((item) => ({
        filePath: item.filePath!,
        sourceChangelist: item.changelistName,
      }));

    if (files.length > 0) {
      dataTransfer.set(
        CHANGELIST_MIME,
        new vscode.DataTransferItem(JSON.stringify(files)),
      );
    }
  }

  public async handleDrop(
    target: ChangelistItem | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (!target || target.kind !== ChangelistItemKind.Changelist) {
      return;
    }

    const raw = dataTransfer.get(CHANGELIST_MIME);
    if (!raw) {
      return;
    }

    let files: { filePath: string; sourceChangelist: string }[];
    try {
      files = JSON.parse(raw.value as string);
    } catch {
      return;
    }

    for (const file of files) {
      try {
        await this.changelistManager.moveToChangelist(
          file.filePath,
          target.changelistName,
        );
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Move failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Changelist actions

  public async createChangelist(): Promise<void> {
    const name = await vscode.window.showInputBox({
      prompt: "Changelist name",
      placeHolder: "My changes",
    });
    if (!name) {
      return;
    }
    try {
      await this.changelistManager.createChangelist(name);
      vscode.window.showInformationMessage(`Changelist "${name}" created`);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  public async renameChangelist(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.Changelist) {
      return;
    }
    const newName = await vscode.window.showInputBox({
      prompt: "New changelist name",
      value: item.changelistName,
    });
    if (!newName || newName === item.changelistName) {
      return;
    }
    try {
      await this.changelistManager.renameChangelist(
        item.changelistName,
        newName,
      );
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  public async deleteChangelist(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.Changelist) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete changelist "${item.changelistName}"? Files will be moved to the default changelist.`,
      { modal: true },
      "Delete",
    );
    if (confirm !== "Delete") {
      return;
    }
    try {
      await this.changelistManager.removeChangelist(item.changelistName);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  public async setAsDefault(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.Changelist) {
      return;
    }
    try {
      await this.changelistManager.setDefaultChangelist(item.changelistName);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  public async commitAll(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.Changelist) {
      return;
    }
    const changelists = this.changelistManager.getChangelists();
    const cl = changelists.find((c) => c.name === item.changelistName);
    if (!cl || cl.files.length === 0) {
      vscode.window.showInformationMessage("No files in this changelist");
      return;
    }

    for (const file of cl.files) {
      await this.gitService.stageFile(file);
    }

    await vscode.commands.executeCommand(
      "workbench.action.focusActiveEditorGroup",
    );
    await vscode.commands.executeCommand("git.commitStaged");
  }

  public async showFileDiff(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.File || !item.filePath) {
      return;
    }
    const diffs = await this.gitService.getDiff(item.filePath);
    if (diffs.length === 0) {
      const stagedDiffs = await this.gitService.getDiff(item.filePath, true);
      if (stagedDiffs.length === 0) {
        vscode.window.showInformationMessage("No changes detected");
        return;
      }
    }
    const left = vscode.Uri.from({
      scheme: "gitstorm-diff",
      path: item.filePath,
      query: "ref=HEAD",
    });
    const repoRoot = await this.gitService.getRepoRoot();
    const right = vscode.Uri.joinPath(vscode.Uri.file(repoRoot), item.filePath);
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${item.filePath} (working tree)`,
    );
  }

  public async moveFileToChangelist(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.File || !item.filePath) {
      return;
    }

    const changelists = this.changelistManager.getChangelists();
    const targets = changelists
      .filter((cl) => cl.name !== item.changelistName)
      .map((cl) => cl.name);

    if (targets.length === 0) {
      vscode.window.showInformationMessage("No other changelists available");
      return;
    }

    const selected = await vscode.window.showQuickPick(targets, {
      placeHolder: "Move to changelist...",
    });
    if (!selected) {
      return;
    }

    try {
      await this.changelistManager.moveToChangelist(item.filePath, selected);
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  public async removeFileFromChangelist(item: ChangelistItem): Promise<void> {
    if (item.kind !== ChangelistItemKind.File || !item.filePath) {
      return;
    }
    const changelists = this.changelistManager.getChangelists();
    const defaultCl = changelists.find((cl) => cl.isDefault);
    if (defaultCl && defaultCl.name !== item.changelistName) {
      await this.changelistManager.moveToChangelist(
        item.filePath,
        defaultCl.name,
      );
    }
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
