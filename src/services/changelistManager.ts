import * as vscode from "vscode";

// ── Interfaces ──────────────────────────────────────────────────────────

export interface Changelist {
  name: string;
  isDefault: boolean;
  files: string[];
}

// ── Events ──────────────────────────────────────────────────────────────

const STORAGE_KEY = "gitstorm.changelists";

// ── Changelist Manager ──────────────────────────────────────────────────

export class ChangelistManager {
  private changelists: Changelist[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  constructor(private context: vscode.ExtensionContext) {
    this.load();
  }

  private load(): void {
    const stored = this.context.workspaceState.get<Changelist[]>(STORAGE_KEY);
    if (stored && stored.length > 0) {
      this.changelists = stored;
    } else {
      const defaultName = vscode.workspace
        .getConfiguration("gitstorm")
        .get<string>("defaultChangelist", "Default");
      this.changelists = [{ name: defaultName, isDefault: true, files: [] }];
      this.persist();
    }
  }

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(STORAGE_KEY, this.changelists);
    this._onDidChange.fire();
  }

  getChangelists(): Changelist[] {
    return [...this.changelists.map((cl) => ({ ...cl, files: [...cl.files] }))];
  }

  async createChangelist(name: string): Promise<void> {
    if (this.changelists.some((cl) => cl.name === name)) {
      throw new Error(`Changelist "${name}" already exists`);
    }
    this.changelists.push({ name, isDefault: false, files: [] });
    await this.persist();
  }

  async removeChangelist(name: string): Promise<void> {
    const idx = this.changelists.findIndex((cl) => cl.name === name);
    if (idx === -1) {
      throw new Error(`Changelist "${name}" not found`);
    }
    if (this.changelists[idx].isDefault) {
      throw new Error("Cannot remove the default changelist");
    }

    const defaultCl = this.changelists.find((cl) => cl.isDefault)!;
    defaultCl.files.push(...this.changelists[idx].files);
    this.changelists.splice(idx, 1);
    await this.persist();
  }

  async renameChangelist(oldName: string, newName: string): Promise<void> {
    if (this.changelists.some((cl) => cl.name === newName)) {
      throw new Error(`Changelist "${newName}" already exists`);
    }
    const cl = this.changelists.find((c) => c.name === oldName);
    if (!cl) {
      throw new Error(`Changelist "${oldName}" not found`);
    }
    cl.name = newName;
    await this.persist();
  }

  async moveToChangelist(
    filePath: string,
    changelistName: string,
  ): Promise<void> {
    const target = this.changelists.find((cl) => cl.name === changelistName);
    if (!target) {
      throw new Error(`Changelist "${changelistName}" not found`);
    }

    for (const cl of this.changelists) {
      const idx = cl.files.indexOf(filePath);
      if (idx !== -1) {
        cl.files.splice(idx, 1);
      }
    }

    if (!target.files.includes(filePath)) {
      target.files.push(filePath);
    }
    await this.persist();
  }

  getChangelistForFile(filePath: string): string {
    for (const cl of this.changelists) {
      if (cl.files.includes(filePath)) {
        return cl.name;
      }
    }
    const defaultCl = this.changelists.find((cl) => cl.isDefault);
    return defaultCl?.name ?? "Default";
  }

  async setDefaultChangelist(name: string): Promise<void> {
    const target = this.changelists.find((cl) => cl.name === name);
    if (!target) {
      throw new Error(`Changelist "${name}" not found`);
    }
    for (const cl of this.changelists) {
      cl.isDefault = false;
    }
    target.isDefault = true;
    await this.persist();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
