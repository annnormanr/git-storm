import * as vscode from "vscode";
import { GitService, BranchInfo } from "../services/gitService";

export enum BranchItemKind {
  Group = "group",
  Branch = "branch",
}

export class BranchItem extends vscode.TreeItem {
  constructor(
    public readonly kind: BranchItemKind,
    public readonly branchInfo?: BranchInfo,
    label?: string,
    collapsibleState?: vscode.TreeItemCollapsibleState,
  ) {
    super(
      label ?? branchInfo?.name ?? "",
      collapsibleState ?? vscode.TreeItemCollapsibleState.None,
    );

    if (kind === BranchItemKind.Group) {
      this.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      this.contextValue = "branchGroup";
    } else if (branchInfo) {
      this.contextValue = branchInfo.current
        ? "currentBranch"
        : branchInfo.remote
          ? "remoteBranch"
          : "localBranch";

      let description = branchInfo.lastCommitMessage;
      const trackParts: string[] = [];
      if (branchInfo.ahead > 0) {
        trackParts.push(`↑${branchInfo.ahead}`);
      }
      if (branchInfo.behind > 0) {
        trackParts.push(`↓${branchInfo.behind}`);
      }
      if (trackParts.length > 0) {
        description = `${trackParts.join(" ")} — ${description}`;
      }
      this.description = description;

      this.tooltip = new vscode.MarkdownString();
      this.tooltip.appendMarkdown(`**${branchInfo.name}**\n\n`);
      if (branchInfo.upstream) {
        this.tooltip.appendMarkdown(`Tracking: \`${branchInfo.upstream}\`\n\n`);
      }
      if (branchInfo.ahead > 0 || branchInfo.behind > 0) {
        this.tooltip.appendMarkdown(
          `Ahead: ${branchInfo.ahead} / Behind: ${branchInfo.behind}\n\n`,
        );
      }
      this.tooltip.appendMarkdown(
        `Last commit: ${branchInfo.lastCommitHash} — ${branchInfo.lastCommitMessage}`,
      );

      if (branchInfo.current) {
        this.iconPath = new vscode.ThemeIcon(
          "check",
          new vscode.ThemeColor("charts.green"),
        );
      } else if (branchInfo.remote) {
        this.iconPath = new vscode.ThemeIcon("cloud");
      } else {
        this.iconPath = new vscode.ThemeIcon("git-branch");
      }
    }
  }
}

export class BranchTreeProvider implements vscode.TreeDataProvider<BranchItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    BranchItem | undefined
  >();
  public readonly onDidChangeTreeData: vscode.Event<BranchItem | undefined> =
    this._onDidChangeTreeData.event;

  private branches: BranchInfo[] = [];

  constructor(private readonly gitService: GitService) {}

  public refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  public getTreeItem(element: BranchItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(element?: BranchItem): Promise<BranchItem[]> {
    if (!element) {
      try {
        this.branches = await this.gitService.getBranches();
      } catch {
        this.branches = [];
      }

      return [
        new BranchItem(
          BranchItemKind.Group,
          undefined,
          "Local",
          vscode.TreeItemCollapsibleState.Expanded,
        ),
        new BranchItem(
          BranchItemKind.Group,
          undefined,
          "Remote",
          vscode.TreeItemCollapsibleState.Collapsed,
        ),
      ];
    }

    if (element.kind === BranchItemKind.Group) {
      const isRemote = element.label === "Remote";
      return this.branches
        .filter((b) => b.remote === isRemote)
        .sort((a, b) => {
          if (a.current && !b.current) {
            return -1;
          }
          if (!a.current && b.current) {
            return 1;
          }
          return a.name.localeCompare(b.name);
        })
        .map((b) => new BranchItem(BranchItemKind.Branch, b));
    }

    return [];
  }

  public async checkout(item: BranchItem): Promise<void> {
    if (!item.branchInfo) {
      return;
    }
    try {
      await this.gitService.checkoutBranch(item.branchInfo.name);
      vscode.window.showInformationMessage(
        `Switched to branch "${item.branchInfo.name}"`,
      );
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Checkout failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async mergeIntoCurrent(item: BranchItem): Promise<void> {
    if (!item.branchInfo) {
      return;
    }
    try {
      const result = await this.gitService.mergeBranch(item.branchInfo.name);
      vscode.window.showInformationMessage(`Merge: ${result}`);
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Merge failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async rebaseOnto(item: BranchItem): Promise<void> {
    if (!item.branchInfo) {
      return;
    }
    try {
      const result = await this.gitService.rebaseBranch(item.branchInfo.name);
      vscode.window.showInformationMessage(`Rebase: ${result}`);
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Rebase failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async deleteBranch(item: BranchItem): Promise<void> {
    if (!item.branchInfo) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Delete branch "${item.branchInfo.name}"?`,
      { modal: true },
      "Delete",
      "Force Delete",
    );
    if (!confirm) {
      return;
    }
    try {
      await this.gitService.deleteBranch(
        item.branchInfo.name,
        confirm === "Force Delete",
      );
      vscode.window.showInformationMessage(
        `Branch "${item.branchInfo.name}" deleted`,
      );
      this.refresh();
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public async compareWithCurrent(item: BranchItem): Promise<void> {
    if (!item.branchInfo) {
      return;
    }
    try {
      const current = await this.gitService.getCurrentBranch();
      const diffs = await this.gitService.getDiffBetween(
        current,
        item.branchInfo.name,
      );
      if (diffs.length === 0) {
        vscode.window.showInformationMessage(
          `No differences between "${current}" and "${item.branchInfo.name}".`,
        );
        return;
      }
      const fileItems = diffs.map((d) => ({
        label: `$(diff) ${d.newPath}`,
        description: d.status,
        filePath: d.newPath,
      }));
      const picked = await vscode.window.showQuickPick(fileItems, {
        placeHolder: `${diffs.length} file(s) changed between "${current}" and "${item.branchInfo.name}"`,
      });
      if (!picked) {
        return;
      }
      const leftUri = vscode.Uri.parse(
        `gitstorm-branch:${picked.filePath}`,
      ).with({
        query: JSON.stringify({
          ref: current,
          filePath: picked.filePath,
        }),
      });
      const rightUri = vscode.Uri.parse(
        `gitstorm-branch:${picked.filePath}`,
      ).with({
        query: JSON.stringify({
          ref: item.branchInfo.name,
          filePath: picked.filePath,
        }),
      });
      const title = `${picked.filePath} (${current} ↔ ${item.branchInfo.name})`;
      await vscode.commands.executeCommand(
        "vscode.diff",
        leftUri,
        rightUri,
        title,
      );
    } catch (err: unknown) {
      vscode.window.showErrorMessage(
        `Compare failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  public dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}
