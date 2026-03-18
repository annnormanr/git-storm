import * as vscode from "vscode";
import * as path from "path";
import { GitService, BlameLine } from "../services/gitService";

function relativeDate(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) {
    return `${years} year${years > 1 ? "s" : ""} ago`;
  }
  if (months > 0) {
    return `${months} month${months > 1 ? "s" : ""} ago`;
  }
  if (days > 0) {
    return `${days} day${days > 1 ? "s" : ""} ago`;
  }
  if (hours > 0) {
    return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  }
  if (minutes > 0) {
    return `${minutes} min ago`;
  }
  return "just now";
}

const UNCOMMITTED_HASH = "0000000000000000000000000000000000000000";

export class BlameProvider implements vscode.Disposable {
  private static readonly MAX_CACHE_SIZE = 50;
  private enabled = false;
  private annotationsEnabled = false;
  private blameCache = new Map<string, BlameLine[]>();
  private disposables: vscode.Disposable[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly inlineDecorationType: vscode.TextEditorDecorationType;
  private readonly gutterDecorationTypes = new Map<
    string,
    vscode.TextEditorDecorationType
  >();

  constructor(private readonly gitService: GitService) {
    const config = vscode.workspace.getConfiguration("gitstorm");
    this.enabled = config.get<boolean>("showInlineBlame", true);

    this.inlineDecorationType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor("editorCodeLens.foreground"),
        fontStyle: "italic",
        margin: "0 0 0 3em",
      },
      isWholeLine: true,
    });

    this.disposables.push(
      this.inlineDecorationType,
      vscode.window.onDidChangeActiveTextEditor(() => this.onEditorChange()),
      vscode.window.onDidChangeTextEditorSelection((e) =>
        this.onSelectionChange(e),
      ),
      vscode.workspace.onDidSaveTextDocument((doc) =>
        this.invalidateCache(doc.uri),
      ),
    );
  }

  public toggle(): void {
    this.enabled = !this.enabled;
    if (this.enabled) {
      this.updateInlineBlame();
    } else {
      this.clearInlineDecorations();
    }
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  public toggleAnnotations(): void {
    this.annotationsEnabled = !this.annotationsEnabled;
    if (this.annotationsEnabled) {
      this.updateGutterAnnotations();
    } else {
      this.clearGutterAnnotations();
    }
  }

  public async toggleFileAnnotations(_uri: vscode.Uri): Promise<void> {
    this.toggleAnnotations();
  }

  public async toggleInlineAnnotations(): Promise<void> {
    this.toggle();
  }

  public isAnnotationsEnabled(): boolean {
    return this.annotationsEnabled;
  }

  private onEditorChange(): void {
    if (this.enabled) {
      this.updateInlineBlame();
    }
    if (this.annotationsEnabled) {
      this.updateGutterAnnotations();
    }
  }

  private onSelectionChange(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.enabled) {
      return;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.updateInlineBlame(e.textEditor);
    }, 200);
  }

  private invalidateCache(uri: vscode.Uri): void {
    this.blameCache.delete(uri.fsPath);
    if (this.enabled) {
      this.updateInlineBlame();
    }
    if (this.annotationsEnabled) {
      this.updateGutterAnnotations();
    }
  }

  private async getBlameData(
    editor: vscode.TextEditor,
  ): Promise<BlameLine[] | undefined> {
    const uri = editor.document.uri;
    if (uri.scheme !== "file") {
      return undefined;
    }

    const fsPath = uri.fsPath;
    const cached = this.blameCache.get(fsPath);
    if (cached) {
      return cached;
    }

    try {
      const repoRoot = await this.gitService.getRepoRoot();
      const relativePath = path.relative(repoRoot, fsPath).replace(/\\/g, "/");
      const blameLines = await this.gitService.getBlame(relativePath);
      this.blameCache.set(fsPath, blameLines);
      if (this.blameCache.size > BlameProvider.MAX_CACHE_SIZE) {
        const oldest = this.blameCache.keys().next().value;
        if (oldest !== undefined) {
          this.blameCache.delete(oldest);
        }
      }
      return blameLines;
    } catch {
      return undefined;
    }
  }

  private async updateInlineBlame(editor?: vscode.TextEditor): Promise<void> {
    editor = editor ?? vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const blameLines = await this.getBlameData(editor);
    if (!blameLines || editor !== vscode.window.activeTextEditor) {
      return;
    }

    const line = editor.selection.active.line;
    const blameLine = blameLines.find((b) => b.finalLine === line + 1);
    if (!blameLine || blameLine.hash === UNCOMMITTED_HASH) {
      editor.setDecorations(this.inlineDecorationType, []);
      return;
    }

    const text = `  ${blameLine.author}, ${relativeDate(blameLine.authorDate)} — ${blameLine.summary}`;

    const range = editor.document.lineAt(line).range;
    const hoverMessage = new vscode.MarkdownString();
    hoverMessage.isTrusted = true;
    hoverMessage.appendMarkdown(`**${blameLine.summary}**\n\n`);
    hoverMessage.appendMarkdown(
      `Commit: \`${blameLine.hash.substring(0, 10)}\`\n\n`,
    );
    hoverMessage.appendMarkdown(
      `Author: ${blameLine.author} <${blameLine.authorEmail}>\n\n`,
    );
    hoverMessage.appendMarkdown(
      `Date: ${blameLine.authorDate.toLocaleString()}\n\n`,
    );
    hoverMessage.appendMarkdown(
      `Line: ${blameLine.originalLine} → ${blameLine.finalLine}`,
    );

    const decoration: vscode.DecorationOptions = {
      range,
      hoverMessage,
      renderOptions: {
        after: { contentText: text },
      },
    };

    editor.setDecorations(this.inlineDecorationType, [decoration]);
  }

  private async updateGutterAnnotations(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    this.clearGutterAnnotations();

    const blameLines = await this.getBlameData(editor);
    if (!blameLines || editor !== vscode.window.activeTextEditor) {
      return;
    }

    const grouped = new Map<
      string,
      { lines: number[]; blameLine: BlameLine }
    >();
    for (const bl of blameLines) {
      const key = bl.hash;
      const existing = grouped.get(key);
      if (existing) {
        existing.lines.push(bl.finalLine - 1);
      } else {
        grouped.set(key, { lines: [bl.finalLine - 1], blameLine: bl });
      }
    }

    for (const [hash, group] of grouped) {
      if (hash === UNCOMMITTED_HASH) {
        continue;
      }

      const shortText = `${group.blameLine.author.substring(0, 12).padEnd(12)} ${relativeDate(group.blameLine.authorDate).padEnd(14)}`;

      const decorationType = vscode.window.createTextEditorDecorationType({
        gutterIconSize: "contain",
        before: {
          contentText: shortText,
          color: new vscode.ThemeColor("editorCodeLens.foreground"),
          width: "26ch",
          fontStyle: "normal",
        },
        isWholeLine: true,
      });

      this.gutterDecorationTypes.set(
        `${hash}-${group.lines[0]}`,
        decorationType,
      );

      const hoverMessage = new vscode.MarkdownString();
      hoverMessage.isTrusted = true;
      hoverMessage.appendMarkdown(`**${group.blameLine.summary}**\n\n`);
      hoverMessage.appendMarkdown(
        `\`${hash.substring(0, 10)}\` by ${group.blameLine.author}\n\n`,
      );
      hoverMessage.appendMarkdown(
        `${group.blameLine.authorDate.toLocaleString()}`,
      );

      const decorations: vscode.DecorationOptions[] = group.lines
        .filter((line) => line >= 0 && line < editor.document.lineCount)
        .map((line) => ({
          range: editor.document.lineAt(line).range,
          hoverMessage,
        }));

      editor.setDecorations(decorationType, decorations);
    }
  }

  private clearInlineDecorations(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.inlineDecorationType, []);
    }
  }

  private clearGutterAnnotations(): void {
    for (const [, decorationType] of this.gutterDecorationTypes) {
      decorationType.dispose();
    }
    this.gutterDecorationTypes.clear();
  }

  public dispose(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.clearGutterAnnotations();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
