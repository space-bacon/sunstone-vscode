import * as vscode from "vscode";
import { Places, Place } from "./places";
import { LocalServer } from "./local";
import { probe, Probe } from "./probe";

// The Places view: every place a model can run, what it holds, what is loaded. "This machine" is the llama-server
// Sunstone starts plus anything found on the usual local ports; "Your servers" are the saved places. A model row
// loads that model there (the page's pick) and makes it the chat's model.

export type Node =
  | { kind: "group"; id: "local" | "servers"; label: string }
  | { kind: "localServer" }
  | { kind: "place"; place: Place; discovered?: boolean }
  | { kind: "model"; place: Place; model: string; status: string; router: boolean }
  | { kind: "note"; label: string; description?: string; command?: vscode.Command };

const DISCOVER: { port: number; name: string }[] = [{ port: 11434, name: "ollama" }, { port: 1234, name: "lm-studio" }, { port: 8080, name: "llama-server" }, { port: 8081, name: "llama-server-8081" }];

export const tileId = (url: string, model: string, router: boolean) => router ? `remote:${url}|${model}` : `remote:${url}`;

export class PlacesTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private probes = new Map<string, Probe>();
  private discovered: Place[] = [];
  private timer: NodeJS.Timeout | undefined;
  private view: vscode.TreeView<Node> | undefined;
  /** The chat's current model tile id, for the marker. */
  current = "";

  constructor(private readonly places: Places, private readonly local: LocalServer) {
    places.onDidChange(() => this.refresh());
    local.onDidChange(() => this.refresh());
  }

  attach(view: vscode.TreeView<Node>): void {
    this.view = view;
    view.onDidChangeVisibility((e) => { if (e.visible) { this.refresh(); this.timer ??= setInterval(() => this.refresh(), 15_000); } else if (this.timer) { clearInterval(this.timer); this.timer = undefined; } });
  }

  probeOf(url: string): Probe | undefined { return this.probes.get(url.replace(/\/$/, "")); }

  async refresh(): Promise<void> {
    const saved = this.places.list();
    const found: Place[] = [];
    await Promise.all([
      ...saved.map(async (p) => this.probes.set(p.url, await probe(p.url, await this.places.key(p.url)))),
      (async () => { if (this.local.running || this.local.startedAt) this.probes.set(this.local.url, await probe(this.local.url, await this.local.getKey())); })(),
      ...DISCOVER.filter((d) => !saved.some((p) => p.url === `http://127.0.0.1:${d.port}` || p.url === `http://localhost:${d.port}`) && `http://127.0.0.1:${d.port}` !== this.local.url).map(async (d) => {
        const url = `http://127.0.0.1:${d.port}`; const pr = await probe(url, "", 1200);
        if (pr.up) { found.push({ name: d.name, url, enabled: true }); this.probes.set(url, pr); }
      }),
    ]);
    this.discovered = found;
    this.changed.fire(undefined);
  }

  getChildren(n?: Node): Node[] {
    if (!n) return [{ kind: "group", id: "local", label: "this machine" }, { kind: "group", id: "servers", label: "your servers" }];
    if (n.kind === "group" && n.id === "local") {
      const localPlace = this.places.list().find((p) => p.url === this.local.url);
      const rows: Node[] = [{ kind: "localServer" }];
      const pr = this.probes.get(this.local.url);
      if (pr?.up) rows.push(...this.modelRows(localPlace || { name: "local", url: this.local.url, enabled: true }, pr));
      for (const d of this.discovered) rows.push({ kind: "place", place: d, discovered: true });
      return rows;
    }
    if (n.kind === "group") {
      const list = this.places.list().filter((p) => p.url !== this.local.url);
      return list.length ? list.map((place) => ({ kind: "place" as const, place })) : [{ kind: "note", label: "no places yet", description: "add a pairing line or a server URL", command: { command: "sunstone.pair", title: "add" } }];
    }
    if (n.kind === "place") { const pr = this.probes.get(n.place.url); return pr?.up ? this.modelRows(n.place, pr) : [{ kind: "note", label: pr?.error ? `not answering (${pr.error})` : "not probed yet" }]; }
    return [];
  }

  private modelRows(place: Place, pr: Probe): Node[] {
    const order = { loaded: 0, loading: 1, unknown: 2, unloaded: 3, failed: 4 } as Record<string, number>;
    // The local server's sizes come from the scan; a router does not report them.
    const size = (m: { id: string; sizeGb?: number }) => m.sizeGb ?? (place.url === this.local.url ? this.local.models.find((x) => x.name === m.id)?.sizeGb : undefined) ?? 0;
    return [...pr.models].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || size(a) - size(b) || a.id.localeCompare(b.id)).map((m) => ({ kind: "model" as const, place, model: m.id, status: m.status, router: pr.router }));
  }

  getTreeItem(n: Node): vscode.TreeItem {
    if (n.kind === "group") { const t = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded); t.contextValue = `group.${n.id}`; return t; }
    if (n.kind === "localServer") {
      const running = this.local.running, pr = this.probes.get(this.local.url), bin = this.local.binary;
      const t = new vscode.TreeItem(`llama-server${running || pr?.up ? "" : ""}`, vscode.TreeItemCollapsibleState.None);
      t.description = running ? `running on ${this.local.port}${pr?.loaded ? ` · ${pr.loaded}` : ""}` : pr?.up ? `answering on ${this.local.port} (not started by Sunstone)` : bin ? `${this.local.scan().length} models under ${this.local.dirs.map((d) => d.replace(process.env.HOME || "", "~")).join(", ") || "no model directory"}` : "not installed (brew install llama.cpp)";
      t.iconPath = new vscode.ThemeIcon(running ? "debug-start" : bin ? "server-process" : "warning");
      t.contextValue = running ? "local.running" : bin ? "local.stopped" : "local.missing";
      t.tooltip = bin ? `${bin}\n${this.local.dirs.join("\n")}` : "llama-server not found on PATH; set sunstone.local.llamaServer";
      t.command = { command: running ? "sunstone.stopLocal" : "sunstone.startLocal", title: running ? "stop" : "start" };
      return t;
    }
    if (n.kind === "place") {
      const pr = this.probes.get(n.place.url);
      const t = new vscode.TreeItem(n.place.name, pr?.up ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      const host = (() => { try { return new URL(n.place.url).host; } catch { return n.place.url; } })();
      t.description = pr ? (pr.up ? `${pr.kind} · ${pr.loaded ? `serving ${pr.loaded}` : `${pr.models.length} models, none loaded`}${n.discovered ? " · found" : ""}` : "down") : "…";
      t.tooltip = `${n.place.url}${pr?.ctx ? `\nwindow ${pr.ctx}` : ""}${pr?.error ? `\n${pr.error}` : ""}`;
      t.iconPath = new vscode.ThemeIcon(pr?.up ? "vm-active" : "vm-outline");
      t.contextValue = n.discovered ? "place.found" : "place";
      t.id = `place:${n.place.url}`;
      if (!pr?.up && host) t.description = `down · ${host}`;
      return t;
    }
    if (n.kind === "model") {
      const id = tileId(n.place.url, n.model, n.router);
      const t = new vscode.TreeItem(n.model, vscode.TreeItemCollapsibleState.None);
      const isCurrent = this.current === id;
      t.description = `${n.status === "loaded" ? "loaded" : n.status === "loading" ? "loading…" : n.status === "failed" ? "failed" : n.status === "unknown" ? "" : "on disk"}${isCurrent ? " · in the chat" : ""}`;
      t.iconPath = new vscode.ThemeIcon(isCurrent ? "circle-filled" : n.status === "loaded" ? "circle-large-filled" : n.status === "loading" ? "loading~spin" : n.status === "failed" ? "error" : "circle-large-outline");
      t.contextValue = "model";
      t.id = `model:${id}`;
      t.command = { command: "sunstone.loadModel", title: "load", arguments: [n] };
      return t;
    }
    const t = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.None); t.description = n.description; t.command = n.command; t.iconPath = new vscode.ThemeIcon("info"); return t;
  }

  dispose(): void { if (this.timer) clearInterval(this.timer); }
}
