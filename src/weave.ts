import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { Host, PageServer } from "./host";

// The Weave service: the Black Window page in search-only mode (`?chat=0&size=0.6B`: the reader and the memory, no
// chat model) inside a sidebar view that stays resident. Folders the user picks are woven into it file by file
// (bw.index: passages only, nothing rides in a prompt), re-read at search time when they have changed, and searched by the tools and the
// participant through bw.notes. The view is small on purpose: the chat lives in VS Code's own chat.

export interface Hit { key: string; score: number; raw?: number; cen?: number; text: string; source: string; kind?: string }
export type SearchKind = "auto" | "text" | "code" | "all";
// A question that names an identifier, a file, or asks where something is defined wants code rows first; the rest
// want the notes and docs first. Measured (BENCHMARKS §11): within noise on repo and code (−3..+1 of 24), so it is
// off by default ("all") and on only when the caller asks for text or code (or "auto" to guess).
// `where` was un-anchored and `variable` dropped on 2026-09-17, then reverted. The classification was right: it
// moved L8 to code and D3 to text, and at kind=code weave.ts returns at rank 4 with the PER_SOURCE passage at
// rank 7 where at kind=text neither appears at all. It scored 5, 7, 8 against the same code's 8, 8, 7, and L8 still
// named the wrong source in 0 of 2, because the model cites rank 1 either way. Classifying the question better does
// not make the model read further down the list.
const CODE_Q = /^\s*(where|which (script|file|module|function))\b|[A-Za-z_]\w*\(|\b\w+_\w+\b|\.(ts|tsx|js|mjs|py|rs|go|html|css|json|toml|yaml|yml|sh)\b|\b(function|method|class|const|variable|regex|handler|callback|struct|enum|module|import|export|implemented|defined|declared|in the code|source code|signature|parameter|argument)\b/i;
export const guessKind = (q: string): "text" | "code" => (CODE_Q.test(q) ? "code" : "text");

const TEXT_EXT = /\.(md|mdx|txt|rst|adoc|json|jsonc|yaml|yml|toml|ini|cfg|conf|env\.example|csv|tsv|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|py|pyi|rb|go|rs|java|kt|kts|swift|m|mm|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|graphql|proto|tex|bib|xml|svg|vue|svelte|astro|dockerfile|makefile|cmake|gradle|lock|log|org|ipynb|r|jl|lua|pl|scala|clj|ex|exs|erl|hs|ml|nim|zig|dart|tf|hcl)$/i;
// A virtualenv is named .venv-<something> as often as .venv, and nobody wants site-packages in the weave.
// The assessment writes one JSON per run holding every answer a model gave, and those land inside woven folders:
// `.sunstone/` beside the queue, and the register's `evidence/assess_*/` once filed. Weaving them lets a run
// retrieve an earlier run's answers as evidence. Measured 2026-09-22: 606 of 1,684 returned passages (36%) were
// previous runs' artifacts, against 1 of 840 the day before any had been filed, and the ledger content they
// displaced took the off-arm score from 37.5 to 25.0 on the same items. Matched by name because the same files
// are reachable from two folders under different paths.
export const ARTIFACT = /(\d{4}-\d\d-\d\dT[\d-]+Z-(editor|harness)-.*\.json|batch\.jsonl)$/i;

export const EXCLUDE = "**/{node_modules,.git,.hg,.svn,dist,out,build,target,.next,.nuxt,.venv,.venv-*,venv,env,__pycache__,.mypy_cache,.pytest_cache,.vscode-test,coverage,.cache,.turbo,vendor,Pods,DerivedData,.sunstone}/**";
// EXCLUDE's directory names as a path test, so a watcher event under one is dropped without a glob engine.
const EXCLUDED_DIR = new RegExp("(^|/)(" + /\{(.*)\}/.exec(EXCLUDE)![1].split(",").map((d) => d.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|") + ")(/|$)");
const NAMED = /(^|[\\/])(Dockerfile|Makefile|README|LICENSE|CHANGELOG)[^\\/]*$/i;
/** The name test the folder walk applies. Every path into the index goes through it. */
const weavable = (p: string) => (TEXT_EXT.test(p) || NAMED.test(p)) && !ARTIFACT.test(p);
// `bw()` carries its arguments inside an eval'd code string, so one call's text is bounded; a longer file goes in
// several calls under the one source, which the page's keys count on from. Only a file past the ceiling is dropped.
const MAX_CALL_BYTES = 1536 * 1024;
const MAX_FILE_BYTES = 24 * 1024 * 1024;
// Past this many separately marked files, rescan the folder instead. A bulk rewrite is cheaper to
// walk once than to re-read file by file, and the walk also catches the siblings whose watcher
// events were dropped, which is the failure this number exists for.
const BULK_RESCAN = 64;
const SHARDS = 32;
const BIG_SOURCE = 4000;
const ROWS_PER_CALL = 2000;
const PER_SOURCE = 2;
// The marker infra/LOST.md already prescribes: a SUPERSEDED line naming what replaced it. Strict on purpose,
// because prose about superseded runs is common and must not mark the document carrying it, so `SUPERSEDED` in
// backticks mid-sentence and a heading about superseded numbers both fail to match.
const SUPERSEDED = /^[ \t]*(?:<!--[ \t]*)?"?SUPERSEDED"?[ \t]*:[ \t]*"?(.+?)"?,?[ \t]*(?:-->)?[ \t]*$/m;
const HEAD_BYTES = 4096;

/** Sources grouped so one `rows` call carries a bounded number of passages. */
function* batches(sources: string[], counts: Map<string, number>, max = ROWS_PER_CALL): Generator<string[]> {
  let cur: string[] = [], n = 0;
  for (const s of sources) {
    const c = counts.get(s) || 0;
    if (cur.length && n + c > max) { yield cur; cur = []; n = 0; }
    cur.push(s); n += c;
  }
  if (cur.length) yield cur;
}

/** Text in pieces no larger than `max` bytes, cut at line ends where there are any. */
function* slices(text: string, max = MAX_CALL_BYTES): Generator<string> {
  if (Buffer.byteLength(text) <= max) { yield text; return; }
  const chars = Math.floor(max / 4); // a UTF-8 char is at most 4 bytes, so this many never exceeds the budget
  let buf: string[] = [], size = 0;
  for (const line of text.split("\n")) {
    const b = Buffer.byteLength(line) + 1;
    if (b > max) {
      if (buf.length) { yield buf.join("\n"); buf = []; size = 0; }
      for (let i = 0; i < line.length; i += chars) yield line.slice(i, i + chars);
      continue;
    }
    if (size + b > max && buf.length) { yield buf.join("\n"); buf = []; size = 0; }
    buf.push(line); size += b;
  }
  if (buf.length) yield buf.join("\n");
}

export class Weave implements vscode.WebviewViewProvider, vscode.Disposable {
  readonly host: Host;
  private readonly ready = new vscode.EventEmitter<void>();
  private isReady = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private saveFreshen: NodeJS.Timeout | undefined;
  // Files known to differ from what is indexed. A search resolves this before it queries, so a hit is
  // fresh at read time rather than only as fresh as the last save. grep has no staleness window
  // because it reads at query time; this is how the weave gets the same property.
  private readonly stale = new Set<string>();
  // The freshen in flight. A search that arrives during one waits for it: measured 2026-09-24, of three
  // searches issued together after a write, the first took the stale list and the other two read the
  // old text.
  private freshening: Promise<void> = Promise.resolve();
  private readonly watchers = new Map<string, vscode.FileSystemWatcher>();
  private readonly gitStamps = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  counts = new Map<string, number>();
  // The cap the tool path uses, as an arm. Two assessment items need sibling rows of one table to tell the answer
  // from its near-twin, and two slots is what the cap allows them.
  perSource = PER_SOURCE;

  constructor(server: PageServer, private readonly context: vscode.ExtensionContext, private readonly out: vscode.OutputChannel) {
    this.host = new Host(server, "?chat=0&size=0.6B", true);
    this.host.onHello(() => { this.isReady = false; this.publish("starting"); this.start().catch((e) => { out.appendLine(`weave: ${e.message || e}`); this.publish("error", String(e.message || e)); }); });
    this.host.onMessage((m) => {
      if (m?.sun === "event" && m.kind === "log") out.appendLine(`[weave] ${m.line}`);
      if (m?.sun === "error" || m?.sun === "rejection") out.appendLine(`[weave] page ${m.sun}: ${m.message}`);
      if (m?.sun === "cmd" && /^sunstone\./.test(m.command)) vscode.commands.executeCommand(m.command, ...(m.args || [])).then(undefined, (e) => out.appendLine(`weave panel: ${e.message || e}`));
    });
    this.disposables.push(vscode.workspace.onDidSaveTextDocument((d) => this.onSave(d)));
    // An unsaved buffer is already different from the file that was indexed, so mark it on the
    // keystroke and let the next search pay for it. Marking is a Set.add; nothing is embedded here.
    this.disposables.push(vscode.workspace.onDidChangeTextDocument((e) => this.markStale(e.document.uri)));
    this.onDidChange(() => this.publish());
  }

  private lastState: "starting" | "ready" | "error" = "starting"; private lastLog = "";
  /** The view's status panel: state, totals, the woven folders with their counts. */
  publish(state?: "starting" | "ready" | "error", log?: string): void {
    if (state) this.lastState = state; if (log !== undefined) this.lastLog = log;
    const total = [...this.counts.values()].reduce((a, b) => a + b, 0);
    const folders = this.folders.map((f) => ({ name: path.basename(f), path: f, count: this.counts.get(f) }));
    const title = this.lastState === "ready" ? `memory up \u00b7 ${total.toLocaleString()} passages in ${folders.length} folder${folders.length === 1 ? "" : "s"}` : this.lastState === "error" ? "memory failed" : "memory starting";
    this.host.showPanel({ state: this.lastState, title, folders, log: this.lastLog });
  }

  get folders(): string[] { return this.context.workspaceState.get<string[]>("sunstone.weave.folders") || []; }
  private setFolders(list: string[]) { return this.context.workspaceState.update("sunstone.weave.folders", list); }

  /** Note that a path no longer matches its index. Cheap enough to call on every keystroke. A create or
   *  delete may name a directory, which has no extension to test, so those pass `anyName`. */
  private markStale(u: vscode.Uri, anyName = false): void {
    const p = u.fsPath;
    const folder = this.folderOf(p);
    if (!folder || EXCLUDED_DIR.test(path.relative(folder, p).split(path.sep).join("/"))) return;
    if (!anyName && !weavable(p)) return;
    this.stale.add(p);
  }

  private folderOf(p: string): string | undefined { return this.folders.find((f) => p.startsWith(f + path.sep)); }

  /** The folder walk's exclude globs: the built-in list and the folder's own `sunstone.weave.exclude`. */
  private excludeFor(folder: vscode.Uri): string {
    // Scoped to the folder, so a repository can exclude its own files from the weave in .vscode/settings.json
    // without every other folder in the workspace inheriting the rule.
    const extra = (vscode.workspace.getConfiguration("sunstone", folder).get<string[]>("weave.exclude") || []).filter((g) => g && !g.includes(","));
    return extra.length ? `{${[EXCLUDE, ...extra].join(",")}}` : EXCLUDE;
  }

  /** Watch a woven folder for writes that never reach the editor: a terminal command, a git
   * checkout, an agent's own patch tool. onDidSaveTextDocument sees none of those, which is the
   * case that matters while an agent is working. */
  private watch(folder: string): void {
    if (this.watchers.has(folder)) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, "**/*"));
    // A directory deleted whole is reported once, not file by file; creates are only let through
    // extensionless, where a directory renamed into place would otherwise be missed.
    w.onDidCreate((u) => this.markStale(u, !path.extname(u.fsPath)));
    w.onDidChange((u) => this.markStale(u));
    w.onDidDelete((u) => this.markStale(u, true));
    this.watchers.set(folder, w);
    this.disposables.push(w);
  }

  /** Branch and commit for the repository holding a folder, or "" when there is none. A branch switch
   * moves it, and unlike a watcher event a read cannot be dropped: inotify's queue overflows under
   * a bulk rewrite and the VS Code API exposes no overflow signal to notice that it happened. The
   * folder may sit below the repository's top, and a linked worktree or a submodule has a .git file
   * naming its git directory, with a worktree's branches in the common directory that one names. */
  private gitStamp(folder: string): string {
    try {
      let top = folder;
      while (!fs.existsSync(path.join(top, ".git"))) {
        const up = path.dirname(top);
        if (up === top) return "";
        top = up;
      }
      let git = path.join(top, ".git");
      if (fs.statSync(git).isFile()) {
        const d = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, "utf8"));
        if (!d) return "";
        git = path.resolve(top, d[1].trim());
      }
      const commondir = path.join(git, "commondir");
      const common = fs.existsSync(commondir) ? path.resolve(git, fs.readFileSync(commondir, "utf8").trim()) : git;
      const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
      const m = /^ref:\s*(.+)$/.exec(head);
      if (!m) return head;
      const ref = m[1];
      const loose = path.join(common, ...ref.split("/"));
      if (fs.existsSync(loose)) return `${ref}:${fs.readFileSync(loose, "utf8").trim()}`;
      const packed = path.join(common, "packed-refs");
      if (fs.existsSync(packed)) {
        for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
          const [sha, name] = line.split(" ");
          if (name === ref) return `${ref}:${sha}`;
        }
      }
      return ref;
    } catch {
      return "";
    }
  }

  /** Bring every known-stale file back in line before a query reads from the index, one freshen at a
   * time. Usually there is nothing to do. While an agent is editing it holds the one or two files it has
   * touched; after a branch switch it rescans the folder, which stats every file and re-embeds only what
   * moved. */
  private freshen(): Promise<void> {
    const run = this.freshening.then(() => this.freshenNow());
    this.freshening = run.catch(() => undefined);
    return run;
  }

  private async freshenNow(): Promise<void> {
    // A closed page is left alone: a save must not reopen the view, and the next search opens it and catches up.
    if (!this.isReady || !this.host.isOpen) return;
    const rescan = new Set<string>();
    for (const f of this.folders) {
      const now = this.gitStamp(f);
      if (!now) continue;
      const was = this.gitStamps.get(f);
      this.gitStamps.set(f, now);
      if (was !== undefined && was !== now) {
        rescan.add(f);
        this.out.appendLine(`[weave] ${path.basename(f)}: working tree moved to ${now}, rescanning`);
      }
    }
    if (!this.stale.size && !rescan.size) return;
    const paths = [...this.stale];
    this.stale.clear();
    if (paths.length > BULK_RESCAN) {
      for (const p of paths) {
        const f = this.folderOf(p);
        if (f) rescan.add(f);
      }
      this.out.appendLine(`[weave] ${paths.length} files marked at once, rescanning ${rescan.size} folder(s)`);
    }
    // What each marked path is now. Gone: its source goes, and so does every source under it, since a
    // deleted directory is reported once. Already woven: re-read. New, a file or a directory renamed into
    // place: asked of the folder walk's own globs, so a file written later meets the rules the weave was
    // built with. Measured 2026-09-24 before this: build output, a virtualenv and an excluded directory
    // written after the weave were all indexed by the first search.
    const drop = new Set<string>(), reread: [string, string][] = [], ask = new Map<string, string[]>();
    for (const p of paths) {
      const folder = this.folderOf(p);
      if (!folder || rescan.has(folder)) continue;
      const source = this.sourceName(folder, p);
      const st = await vscode.workspace.fs.stat(vscode.Uri.file(p)).then((s) => s, () => undefined);
      if (!st) {
        drop.add(source);
        for (const s of this.mtimes.keys()) if (s.startsWith(source + "/")) drop.add(s);
        continue;
      }
      const dir = (st.type & vscode.FileType.Directory) !== 0;
      if (!dir && !weavable(p)) continue;
      if (!dir && this.mtimes.has(source)) { reread.push([folder, p]); continue; }
      const rel = path.relative(folder, p).split(path.sep).join("/");
      // A brace list cannot carry these characters; the folder walk can.
      if (/[{}[\],*?!]/.test(rel)) { rescan.add(folder); continue; }
      (ask.get(folder) || ask.set(folder, []).get(folder)!).push(dir ? `${rel}/**` : rel);
    }
    for (const [folder, globs] of ask) {
      if (rescan.has(folder)) continue;
      const base = vscode.Uri.file(folder);
      const found = (await vscode.workspace.findFiles(new vscode.RelativePattern(base, globs.length === 1 ? globs[0] : `{${globs.join(",")}}`), this.excludeFor(base))).map((u) => u.fsPath).filter(weavable);
      if (found.length > BULK_RESCAN) { rescan.add(folder); continue; }
      for (const p of found) reread.push([folder, p]);
    }
    for (const f of rescan) {
      try {
        const r = await this.indexFolder(vscode.Uri.file(f), true);
        this.out.appendLine(`[weave] ${path.basename(f)}: rescanned, ${r.files} files, ${r.passages} passages`);
      } catch (e: any) {
        this.out.appendLine(`weave rescan ${f}: ${e.message || e}`);
      }
    }
    for (const s of drop) {
      await this.host.bw("unindex", [s], 30_000).catch(() => undefined);
      this.mtimes.delete(s);
      this.out.appendLine(`[weave] ${s}: gone, dropped from the index`);
    }
    for (const [folder, p] of reread) {
      if (rescan.has(folder)) continue;
      const source = this.sourceName(folder, p);
      try {
        const r = await this.indexFile(vscode.Uri.file(p), vscode.Uri.file(folder), true);
        this.out.appendLine(`[weave] ${source}: ${r.n} passages (re-read)`);
      } catch (e: any) {
        this.out.appendLine(`weave freshen ${source}: ${e.message || e}`);
      }
    }
    this.scheduleSave();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    view.description = "memory";
    this.host.attach(view).catch((e) => this.out.appendLine(`weave view: ${e.message || e}`));
  }

  get up(): boolean { return this.isReady; }

  /** Makes sure the view exists and the page is in search-only mode with its reader up. */
  async ensure(timeoutMs = 180_000): Promise<void> {    if (!this.host.isOpen) { await vscode.commands.executeCommand("sunstone.weave.focus"); }
    if (this.isReady) return;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => { d.dispose(); reject(new Error("the weave did not come up (see the Black Window output)")); }, timeoutMs);
      const d = this.ready.event(() => { clearTimeout(t); d.dispose(); resolve(); });
    });
  }

  // After hello: wait for the catalog, press Load with no model chosen (search-only under ?chat=0), wait for the reader.
  private async start(): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000 && !(await this.host.eval<boolean>(`return !!(window.bw && document.querySelectorAll("#models .opt").length && !document.getElementById("load").disabled);`, 5000).catch(() => false))) await sleep(1000);
    await this.host.eval(`document.getElementById("load").click(); return true;`, 5000);
    while (Date.now() - t0 < 180_000) {
      const s = await this.host.eval<string>(`return (document.querySelector("#status")?.textContent || "").trim();`, 5000).catch(() => "");
      if (/^ready/.test(s)) break;
      if (/error|failed/i.test(s)) throw new Error(s);
      await sleep(1000);
    }
    this.out.appendLine(`[weave] up in ${Math.round((Date.now() - t0) / 1000)} s`);
    // The saved weave comes back in one read (vectors included, no re-embedding) before anyone may index or search;
    // then only files whose mtime moved.
    await this.restore().catch((e) => this.out.appendLine(`weave restore: ${e.message || e}`));
    this.isReady = true; this.ready.fire();
    this.publish("ready");
    for (const f of this.folders) this.indexFolder(vscode.Uri.file(f), true).catch((e) => this.out.appendLine(`weave ${f}: ${e.message || e}`));
  }

  // Persistence: the page's rows in a handful of shard files under `weave/`, each holding whole sources. A save
  // rewrites only the shards whose sources changed, so no write is proportional to the store and no single
  // JSON.stringify holds all of it. `meta.json` carries the woven files' mtimes.
  private get dir(): vscode.Uri | undefined { return this.context.storageUri && vscode.Uri.joinPath(this.context.storageUri, "weave"); }
  private get legacy(): vscode.Uri | undefined { return this.context.storageUri && vscode.Uri.joinPath(this.context.storageUri, "weave.json"); }
  // One long document can hold half the store (a 10 MB transcript wove to 29,744 passages), and a shard holding it
  // costs its whole size every time any of its neighbours moves. Past the threshold a source gets a file of its own.
  private file(source: string, passages: number): string {
    let h = 2166136261; for (let i = 0; i < source.length; i++) { h ^= source.charCodeAt(i); h = Math.imul(h, 16777619); }
    return passages >= BIG_SOURCE ? `big-${(h >>> 0).toString(36)}.json` : `shard-${(h >>> 0) % SHARDS}.json`;
  }
  private placed = new Map<string, string>();
  private persisted = new Map<string, number>();
  private dirty = new Set<string>();
  private mtimes = new Map<string, number>();
  private saveTimer: NodeJS.Timeout | undefined;
  private blocked = false;
  private migrate = false;
  private format = "blackwindow-session";

  markDirty(source: string): void { this.dirty.add(source); }

  private async readJson(u: vscode.Uri): Promise<any | undefined> {
    let raw: Uint8Array; try { raw = await vscode.workspace.fs.readFile(u); } catch { return undefined; }
    try { return JSON.parse(Buffer.from(raw).toString("utf8")); } catch (e: any) {
      // Notes, lookups and digests have no file to re-weave from, so an unreadable file is kept, never saved over.
      const aside = u.with({ path: u.path.replace(/\.json$/, `.corrupt-${Date.now()}.json`) });
      try { await vscode.workspace.fs.rename(u, aside, { overwrite: false }); this.out.appendLine(`[weave] unreadable ${path.basename(u.fsPath)} kept at ${aside.fsPath} (${e.message || e})`); }
      catch { this.blocked = true; this.out.appendLine(`[weave] unreadable ${u.fsPath}; saving is off so it stands (${e.message || e})`); }
      return undefined;
    }
  }

  private async writeJson(u: vscode.Uri, value: unknown): Promise<number> {
    const body = Buffer.from(JSON.stringify(value));
    const tmp = u.with({ path: u.path + ".tmp" });
    await vscode.workspace.fs.writeFile(tmp, body);
    await vscode.workspace.fs.rename(tmp, u, { overwrite: true });
    return body.length;
  }

  private async restore(): Promise<void> {
    // The page has just started and holds nothing, so no mtime from its last life describes it. Left
    // in place with no store to restore, they made the re-weave skip every file into an empty index.
    this.mtimes.clear();
    if (!this.dir) return;
    const t0 = Date.now();
    this.format = await this.host.eval<string>("return SESSION_FORMAT;", 10_000).catch(() => this.format) || this.format;
    let held = 0, vectors = 0, added = 0;
    const meta = await this.readJson(vscode.Uri.joinPath(this.dir, "meta.json"));
    if (meta) {
      this.mtimes = new Map(Object.entries(meta.mtimes || {}));
      let here: [string, vscode.FileType][] = [];
      try { here = await vscode.workspace.fs.readDirectory(this.dir); } catch { here = []; }
      for (const [name] of here) {
        if (!/^(shard-\d+|big-[a-z0-9]+)\.json$/.test(name)) continue;
        const data = await this.readJson(vscode.Uri.joinPath(this.dir, name));
        if (!data?.sources) continue;
        const passages: any[] = [], keys: string[] = [], parts: Buffer[] = [];
        let dim = 384;
        for (const [source, row] of Object.entries<any>(data.sources)) {
          this.persisted.set(source, (row.passages || []).length);
          this.placed.set(source, name);
          // Written before the threshold existed, or before it grew past it: the next save gives it its own file.
          if ((row.passages || []).length >= BIG_SOURCE && !name.startsWith("big-")) this.dirty.add(source);
          for (const p of row.passages || []) passages.push({ key: p.key, source, text: p.text });
          if (row.f16) { keys.push(...(row.passages || []).map((p: any) => p.key)); parts.push(Buffer.from(row.f16, "base64")); dim = row.dim || dim; }
        }
        if (!passages.length) continue;
        held += passages.length; vectors += keys.length;
        const f16 = parts.length ? Buffer.concat(parts).toString("base64") : undefined;
        const session = { format: this.format, version: 2, turns: [], attachments: [], passages, vectors: f16 ? { reader: "bge-small", dim, n: keys.length, keys, f16 } : undefined };
        const r = await this.host.bw<{ passages: number }>("import", [session, "weave"], 300_000);
        added += r?.passages || 0;
      }
    } else if (this.legacy) {
      // A store written before the shards: read it whole once, then the next save lays it down in pieces.
      const data = await this.readJson(this.legacy);
      if (!data?.session) return;
      this.mtimes = new Map(Object.entries(data.mtimes || {}));
      held = (data.session.passages || []).length; vectors = data.session.vectors?.n || 0;
      const r = await this.host.bw<{ passages: number }>("import", [data.session, "weave"], 300_000);
      added = r?.passages || 0;
      this.migrate = true;
    } else return;
    const n = await this.host.eval<number>(`return window.bw.sources().reduce((a, s) => a + s.passages, 0);`, 10_000).catch(() => 0);
    const secs = Math.round((Date.now() - t0) / 100) / 10;
    this.out.appendLine(`[weave] restored ${n.toLocaleString()} passages (files held ${held}, vectors ${vectors}, import added ${added}; ${this.mtimes.size} files) in ${secs} s`);
    this.lastRestore = { held, vectors, added, now: n };
    // Per-folder counts from the restored sources, so the panel is right before any re-weave.
    const sources = await this.host.bw<{ source: string; passages: number }[]>("sources", []).catch(() => []);
    // A file whose shard did not come back is not in the page, and its mtime must not let the re-weave skip it.
    const inPage = new Set(sources.map((s) => s.source));
    for (const s of [...this.mtimes.keys()]) if (!inPage.has(s)) this.mtimes.delete(s);
    for (const f of this.folders) { const base = path.basename(f) + "/"; this.counts.set(f, sources.filter((s) => s.source.startsWith(base)).reduce((a, s) => a + s.passages, 0)); }
    this.publish(undefined, `restored ${n.toLocaleString()} passages in ${secs} s`);
  }
  lastRestore: { held: number; vectors: number; added: number; now: number } | undefined;

  scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save().catch((e) => this.out.appendLine(`weave save: ${e.message || e}`)), 20_000);
  }

  async save(): Promise<void> {
    const dir = this.dir; if (!dir || !this.isReady || this.blocked) return;
    // chat: and tool: sources belong to an open conversation, resident only while it is, so they never go to disk.
    const live = new Map((await this.host.bw<{ source: string; passages: number }[]>("sources", [], 60_000)).filter((s) => !/^(chat|tool):/.test(s.source)).map((s) => [s.source, s.passages]));
    // A source whose passage count moved has certainly changed; the marks catch a re-index that landed on the same count.
    const changed = [...live.keys()].filter((s) => this.migrate || this.dirty.has(s) || this.persisted.get(s) !== live.get(s));
    const gone = [...this.persisted.keys()].filter((s) => !live.has(s));
    if (!changed.length && !gone.length) return;
    await vscode.workspace.fs.createDirectory(dir);
    const work = new Map<string, { changed: string[]; gone: string[] }>();
    const at = (name: string) => work.get(name) || work.set(name, { changed: [], gone: [] }).get(name)!;
    for (const s of changed) {
      const name = this.file(s, live.get(s) || 0), was = this.placed.get(s);
      at(name).changed.push(s);
      if (was && was !== name) at(was).gone.push(s); // grew past the threshold, or shrank back
    }
    for (const s of gone) at(this.placed.get(s) || this.file(s, this.persisted.get(s) || 0)).gone.push(s);
    let bytes = 0;
    for (const [name, job] of work) {
      const u = vscode.Uri.joinPath(dir, name);
      const data = (await this.readJson(u)) || { sources: {} };
      for (const s of job.gone) { delete data.sources[s]; if (this.placed.get(s) === name) { this.placed.delete(s); this.persisted.delete(s); } }
      // Rows come back a batch of sources at a time so one message never carries the whole file.
      for (const batch of batches(job.changed, live)) {
        const r = await this.host.bw<{ passages: { key: string; source: string; text: string }[]; vectors?: { dim: number; f16: string } }>("rows", [batch], 300_000);
        const dim = r.vectors?.dim || 384;
        const buf = r.vectors?.f16 ? Buffer.from(r.vectors.f16, "base64") : undefined;
        const got = new Map<string, { passages: { key: string; text: string }[]; parts: Buffer[] }>();
        (r.passages || []).forEach((p, i) => {
          let row = got.get(p.source);
          if (!row) { row = { passages: [], parts: [] }; got.set(p.source, row); }
          row.passages.push({ key: p.key, text: p.text });
          if (buf) row.parts.push(buf.subarray(i * dim * 2, (i + 1) * dim * 2));
        });
        for (const s of batch) {
          const row = got.get(s);
          if (!row) { delete data.sources[s]; this.placed.delete(s); this.persisted.delete(s); continue; }
          data.sources[s] = { passages: row.passages, dim, f16: row.parts.length ? Buffer.concat(row.parts).toString("base64") : undefined };
          this.persisted.set(s, row.passages.length); this.placed.set(s, name);
        }
      }
      bytes += await this.writeJson(u, { savedAt: new Date().toISOString(), sources: data.sources });
    }
    await this.writeJson(vscode.Uri.joinPath(dir, "meta.json"), { version: 1, savedAt: new Date().toISOString(), format: this.format, mtimes: Object.fromEntries(this.mtimes) });
    this.dirty.clear();
    if (this.migrate) {
      this.migrate = false;
      const l = this.legacy;
      if (l) try { await vscode.workspace.fs.rename(l, l.with({ path: l.path + ".migrated" }), { overwrite: true }); } catch { this.out.appendLine("[weave] the pre-shard store is still in place; the shards are what is read now"); }
    }
    this.out.appendLine(`[weave] saved ${changed.length} source${changed.length === 1 ? "" : "s"}${gone.length ? `, dropped ${gone.length}` : ""} in ${work.size} file${work.size === 1 ? "" : "s"}, ${(bytes / 1048576).toFixed(1)} MB written`);
  }


  async indexFolder(folder: vscode.Uri, quiet = false, force = false): Promise<{ files: number; passages: number }> {
    await this.ensure();
    this.watch(folder.fsPath);
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), this.excludeFor(folder));
    const list = files.filter((u) => weavable(u.fsPath));
    let passages = 0, done = 0, skipped = 0;
    const run = async (progress?: vscode.Progress<{ message?: string; increment?: number }>) => {
      for (const u of list) {
        const r = await this.indexFile(u, folder, force).catch((e) => { this.out.appendLine(`weave ${u.fsPath}: ${e.message || e}`); return { n: 0, skipped: false }; });
        passages += r.n; done++; if (r.skipped) skipped++;
        progress?.report({ message: `${done}/${list.length} files, ${passages.toLocaleString()} passages`, increment: 100 / list.length });
      }
    };
    if (quiet) await run(); else await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Black Window: weaving ${path.basename(folder.fsPath)}`, cancellable: false }, run);
    // Files that are gone leave the weave.
    const present = new Set(list.map((u) => this.sourceName(folder.fsPath, u.fsPath)));
    for (const s of [...this.mtimes.keys()]) if (s.startsWith(this.sourceName(folder.fsPath) + "/") && !present.has(s)) { this.mtimes.delete(s); await this.host.bw("unindex", [s]).catch(() => 0); }
    if (!this.folders.includes(folder.fsPath)) await this.setFolders([...this.folders, folder.fsPath]);
    // Record the tree this index was built from, so the first search after it does not read a
    // changed stamp and rescan what was just walked.
    this.gitStamps.set(folder.fsPath, this.gitStamp(folder.fsPath));
    // A re-weave that skipped unchanged files keeps the restored count; a fresh weave counts what it wove.
    if (skipped < list.length || !this.counts.has(folder.fsPath)) { const sources = await this.host.bw<{ source: string; passages: number }[]>("sources", []).catch(() => []); const base = this.sourceName(folder.fsPath) + "/"; this.counts.set(folder.fsPath, sources.filter((s) => s.source.startsWith(base)).reduce((a, s) => a + s.passages, 0)); }
    this.changed.fire();
    this.out.appendLine(`[weave] ${folder.fsPath}: ${list.length} files, ${passages.toLocaleString()} passages${skipped ? `, ${skipped} unchanged` : ""}`);
    this.publish(undefined, `${path.basename(folder.fsPath)}: ${list.length} files${skipped ? `, ${skipped} unchanged` : ""}`);
    if (done > skipped) this.scheduleSave();
    return { files: list.length, passages };
  }

  async forgetFolder(folder: string): Promise<void> {
    await this.setFolders(this.folders.filter((f) => f !== folder));
    this.counts.delete(folder);
    for (const s of [...this.mtimes.keys()]) if (s.startsWith(this.sourceName(folder) + "/")) this.mtimes.delete(s);
    if (this.isReady) {
      const sources = await this.host.bw<{ source: string }[]>("sources", []).catch(() => []);
      for (const s of sources) if (s.source.startsWith(this.sourceName(folder) + "/")) await this.host.bw("unindex", [s.source]).catch(() => 0);
      this.scheduleSave();
    }
    this.changed.fire();
  }

  /** Source names are `<folder name>/<relative path>`: short, unique enough, readable in a citation. */
  sourceName(folder: string, file?: string): string {
    const base = path.basename(folder);
    return file ? `${base}/${path.relative(folder, file).split(path.sep).join("/")}` : base;
  }
  fileOf(source: string): vscode.Uri | undefined {
    for (const f of this.folders) { const base = path.basename(f) + "/"; if (source.startsWith(base)) return vscode.Uri.file(path.join(f, source.slice(base.length))); }
    return undefined;
  }

  // The weave has no notion of a correction, so a replaced document answers a fair question with a withdrawn
  // number: asked by how much the engine beats a reimplementation of its own recipe, it returned the n=160 gap of
  // 0.087 and never the n=391 figure that replaced it (2026-09-16). A hit from a document that declares itself
  // superseded now carries that on the passage. Read from the file rather than the store, so editing the marker
  // takes effect without a re-weave, and cached per source for the session.
  private readonly supersedes = new Map<string, string>();
  private async supersededBy(source: string): Promise<string> {
    const had = this.supersedes.get(source);
    if (had !== undefined) return had;
    let mark = "";
    try {
      const u = this.fileOf(source);
      if (u) mark = (SUPERSEDED.exec(Buffer.from(await vscode.workspace.fs.readFile(u)).subarray(0, HEAD_BYTES).toString("utf8"))?.[1] || "").trim().slice(0, 240);
    } catch { /* unreadable now, so treat it as current */ }
    this.supersedes.set(source, mark);
    return mark;
  }

  private async indexFile(u: vscode.Uri, folder: vscode.Uri, force = false): Promise<{ n: number; skipped: boolean }> {
    const stat = await vscode.workspace.fs.stat(u);
    if (stat.size === 0) return { n: 0, skipped: false };
    const source = this.sourceName(folder.fsPath, u.fsPath);
    if (stat.size > MAX_FILE_BYTES) {
      this.out.appendLine(`[weave] ${source}: not woven, ${(stat.size / 1048576).toFixed(1)} MB is past the ${MAX_FILE_BYTES / 1048576} MB ceiling`);
      return { n: 0, skipped: false };
    }
    // Unchanged since it was indexed into this page: nothing to do. The mtimes describe only what the page
    // holds, being cleared when it starts, so this holds for a store built this session as for a restored one.
    if (!force && this.mtimes.get(source) === stat.mtime) return { n: 0, skipped: true };
      // An open buffer with unsaved edits is the file the user and the agent are both looking at, so
      // it is the one to index. Reading from disk here would re-index the version they have already
      // moved past, which is the stale answer this whole path exists to avoid.
      const open = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.fsPath === u.fsPath);
      let text: string;
      if (open) {
        text = open.getText();
      } else {
        const bytes = await vscode.workspace.fs.readFile(u);
        if (bytes.subarray(0, 4096).includes(0)) return { n: 0, skipped: false };
        text = Buffer.from(bytes).toString("utf8");
      }
    const kind = /\.(md|mdx|txt|rst|adoc|org|tex|bib)$/i.test(u.fsPath) || /(^|\/)(README|LICENSE|CHANGELOG)[^/]*$/i.test(u.fsPath) ? "text" : "code";
    await this.host.bw("unindex", [source], 30_000);
    let n = 0;
    for (const part of slices(text)) n += await this.host.bw<number>("index", [source, part, kind], 300_000);
      // A dirty buffer is deliberately left with the mtime of what is on disk, so the save that
      // follows re-indexes rather than being skipped as unchanged.
      if (!open) this.mtimes.set(source, stat.mtime);
    this.dirty.add(source);
    return { n, skipped: false };
  }

  private onSave(d: vscode.TextDocument): void {
    if (!this.isReady) return;
    this.markStale(d.uri);
    // A search would pick this up anyway. Freshening shortly after a save keeps the saved store current
    // for a session that ends before anyone searches, through the same rules and the same queue.
    clearTimeout(this.saveFreshen);
    this.saveFreshen = setTimeout(() => this.freshen().catch((e) => this.out.appendLine(`weave save: ${e.message || e}`)), 1500);
  }

  /** Search the woven folders, notes, memory and lookups. Packs are excluded unless named in `only`. `kind` puts
   *  prose or code rows ahead by a bonus of the same order as the lexical one ("auto" guesses from the question);
   *  it is a preference and not a filter, which it was until 2026-09-17. */
  async search(query: string, k = 8, only?: string[], kind: SearchKind = "all", exclude?: string | string[], perSource = this.perSource): Promise<Hit[]> {
    await this.ensure();
    await this.freshen().catch((e) => this.out.appendLine(`weave freshen: ${e.message || e}`));
    const want = kind === "auto" ? guessKind(query) : kind === "all" ? undefined : kind;
    const opts: any = only ? { only, ...(exclude ? { exclude } : {}) } : { exclude: exclude || ["pack:", "chat:", "tool:"] }; if (want) opts.kind = want;
    // Over-fetch and keep at most PER_SOURCE from any one source: a single long document holds enough near-duplicate
    // passages to take the whole list, and did (measured: one transcript took the top hit on 17 of 38 questions).
    const raw = await this.host.bw<{ key: string; score: number; raw?: number; cen?: number; text: string; kind?: string }[]>("notes", [query, Math.max(k, k * 4), opts], 60_000);
    const seen = new Map<string, number>(); const said = new Set<string>(); const out: Hit[] = [];
    for (const h of raw) {
      if (!h.text) continue;
      const source = h.key.replace(/#\d+$/, "");
      const n = seen.get(source) || 0; if (n >= perSource) continue;
      // The same passage in a second repository is not a second answer, and the per-source cap cannot see it because
      // each copy is its own source. Measured 2026-09-16: one question lost four of six slots to two documents, a
      // release note held in two repositories and a paper held as .md and .tex. Compared without the heading label
      // the weave prefixes, and without LaTeX control words, which are the whole of the difference between a .md
      // copy and its .tex twin.
      const body = h.text.replace(/^\[[^\]]*\]\s*/, "").replace(/\\[a-zA-Z]+/g, " ").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
      if (said.has(body)) continue;
      seen.set(source, n + 1); said.add(body);
      out.push({ ...h, score: Number(h.score) || 0, source });
      if (out.length >= k) break;
    }
    for (const h of out) { const s = await this.supersededBy(h.source); if (s) h.text = `[superseded: ${s}]\n${h.text}`; }
    // Replies the participant kept before 0.1.3, under memory/<day>/chat.
    for (const h of out) if (/^memory\/\d{4}-\d\d-\d\d\/chat$/.test(h.source)) h.text = `[an earlier @blackwindow answer, not a source; check what it cites]\n${h.text}`;
    return out;
  }

  /** The page's live lookup: Wikipedia, the news desk or the web, read into the weave, nearest passages returned. */
  async lookup(query: string, kind: "wiki" | "news" | "web" = "wiki", k = 8): Promise<{ query: string; where: string; read: string[]; lead: string[]; digest: any[]; error: string; hits: Hit[] }> {
    await this.ensure();
    const r = await this.host.bw<any>("lookup", [query, kind, k], 120_000);
    if (r.hits?.length) this.scheduleSave();
    return r;
  }

  /** Material that belongs to one open chat rather than to the store: the turns that no longer fit the model's
   *  window (chat:<id>) and the tool schemas a turn chooses between (tool:<name>). Resident only, never saved, and
   *  searched only when asked for by prefix. */
  async fold(source: string, text: string, replace = true): Promise<number> {
    if (!this.isReady || !text.trim()) return 0;
    if (replace) await this.host.bw("unindex", [source], 30_000);
    let n = 0;
    for (const part of slices(text)) n += await this.host.bw<number>("index", [source, part, "text"], 300_000);
    return n;
  }

  /** The folded passages under one prefix, nearest the question. The per-source cap is lifted here: it exists so one
   *  long document cannot take an ordinary search, but a conversation's whole fold is a single source, so the cap was
   *  returning two passages of it however many were asked for. */
  recall(prefix: string, query: string, k = 8): Promise<Hit[]> { return this.search(query, k, [prefix], "all", undefined, k); }

  /** A note kept across chats: indexed under memory/<day> so a later question finds it. */
  async remember(text: string, label = ""): Promise<number> {
    await this.ensure();
    const day = new Date().toISOString().slice(0, 10);
    const n = await this.host.bw<number>("index", [`memory/${day}${label ? "/" + label.replace(/[^\w.-]+/g, "-").slice(0, 40) : ""}`, text, "text"], 60_000);
    if (n) this.scheduleSave();
    return n;
  }

  /** Drop every source whose name starts with `prefix`, for clearing notes an assessment wrote into the weave. */
  async forgetSources(prefix: string): Promise<number> {
    await this.ensure();
    const sources = await this.host.bw<{ source: string }[]>("sources", []).catch(() => []);
    const hit = sources.filter((s) => s.source.startsWith(prefix));
    for (const s of hit) { this.mtimes.delete(s.source); await this.host.bw("unindex", [s.source]).catch(() => 0); }
    if (hit.length) { this.scheduleSave(); this.changed.fire(); }
    return hit.length;
  }

  // Packs: a specialised weave built from a dataset (worked examples, a documentation set, article openings), kept as
  // the page's session format with vectors so opening one is a read, not a re-embedding. Sources are pack:<name>.
  async buildPack(name: string, texts: string[], batch = 500): Promise<number> {
    await this.ensure();
    const source = `pack:${name}`;
    await this.host.bw("unindex", [source], 60_000).catch(() => 0);
    let n = 0;
    for (let i = 0; i < texts.length; i += batch) n += await this.host.bw<number>("indexMany", [source, texts.slice(i, i + batch)], 600_000);
    this.scheduleSave();
    return n;
  }

  async exportPack(name: string, file: vscode.Uri): Promise<{ passages: number; bytes: number }> {
    await this.ensure();
    const session = await this.host.bw<any>("export", [], 300_000);
    const prefix = `pack:${name}#`;
    const passages = (session.passages || []).filter((p: any) => String(p.key).startsWith(prefix));
    let vectors: any = undefined;
    if (session.vectors?.f16 && Array.isArray(session.vectors.keys)) {
      const v = session.vectors, dim = +v.dim, buf = Buffer.from(v.f16, "base64"), all = new Uint16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      const idx = v.keys.map((k: string, i: number) => [k, i] as [string, number]).filter(([k]: [string, number]) => k.startsWith(prefix));
      const out = new Uint16Array(idx.length * dim);
      idx.forEach(([, i]: [string, number], j: number) => out.set(all.subarray(i * dim, (i + 1) * dim), j * dim));
      vectors = { reader: v.reader, dim, n: idx.length, keys: idx.map(([k]: [string, number]) => k), f16: Buffer.from(out.buffer).toString("base64") };
    }
    const pack = { format: session.format, version: 2, exportedAt: new Date().toISOString(), pack: name, model: "", reader: session.reader, settings: {}, turns: [], passages, vectors, attachments: [] };
    const body = Buffer.from(JSON.stringify(pack));
    await vscode.workspace.fs.writeFile(file, body);
    return { passages: passages.length, bytes: body.length };
  }

  async openPack(file: vscode.Uri): Promise<{ name: string; passages: number; direct: boolean }> {
    await this.ensure();
    const data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"));
    const name = String(data.pack || path.basename(file.fsPath, ".json"));
    const before = await this.host.eval<number>(`return window.bw.sources().reduce((a, s) => a + s.passages, 0);`, 10_000).catch(() => 0);
    const t0 = Date.now();
    const r = await this.host.bw<{ passages: number }>("import", [data, `pack ${name}`], 900_000);
    const secs = (Date.now() - t0) / 1000;
    // A direct read of 7k vectors is under a second; re-embedding them is tens of seconds. The time tells which happened.
    this.out.appendLine(`[weave] pack ${name}: ${r?.passages ?? "?"} passages in ${secs.toFixed(1)} s (${before.toLocaleString()} before)`);
    this.scheduleSave(); this.changed.fire();
    return { name, passages: r?.passages ?? 0, direct: secs < Math.max(2, (r?.passages || 0) / 2000) };
  }

  /** Search within one pack: the notes arm for a benchmark that has a specialised weave. */
  async searchPack(name: string, query: string, k = 4): Promise<Hit[]> {
    const hits = await this.host.bw<{ key: string; score: number; text: string }[]>("notes", [query, k, { only: `pack:${name}` }], 60_000);
    return hits.filter((h) => h.text).map((h) => ({ ...h, score: Number(h.score) || 0, source: h.key.replace(/#\d+$/, "") }));
  }

  dispose(): void { this.host.dispose(); for (const d of this.disposables) d.dispose(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
