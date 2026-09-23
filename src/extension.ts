import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Host, PageEvent, PageServer } from "./host";
import { Places, PlaceWithKey, parsePairing, autoName } from "./places";
import { LocalServer } from "./local";
import { PlacesTree, Node, tileId } from "./tree";
import { addModel } from "./probe";
import { Weave } from "./weave";
import { registerChat } from "./chat";
import { BlackWindowProvider } from "./provider";
import { registerAssess } from "./assess";
import { registerGenerate } from "./generate";
import { registerJudge } from "./judge";

// Sunstone: the Black Window suite in VS Code. The chat panel (the page in a webview) against a place, places and
// keys owned here, the Places view (this machine, your servers, a llama-server started here), and Black Window in
// VS Code's own chat: the Weave over folders you pick as tools any model can call, and the @blackwindow participant.

export interface SunstoneApi {
  host: Host;
  weave: Weave;
  places: Places;
  local: LocalServer;
  tree: PlacesTree;
  provider: BlackWindowProvider;
  open(): Promise<void>;
  ask(text: string, timeoutMs?: number): Promise<{ reply: string; [k: string]: any }>;
  pick(id: string, timeoutMs?: number): Promise<void>;
  waitReady(timeoutMs?: number): Promise<string>;
  events: PageEvent[];
  lastReply: () => string;
}

export function activate(context: vscode.ExtensionContext): SunstoneApi {
  const server = new PageServer(path.join(context.extensionPath, "media"), vscode.workspace.getConfiguration("sunstone").get<number>("port") || 47393);
  const host = new Host(server);
  const places = new Places(context.secrets);
  const local = new LocalServer(context);
  const tree = new PlacesTree(places, local);
  const view = vscode.window.createTreeView("sunstone.places", { treeDataProvider: tree, showCollapseAll: false });
  tree.attach(view);
  const events: PageEvent[] = [];
  const out = vscode.window.createOutputChannel("Black Window");
  const weave = new Weave(server, context, out);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("sunstone.weave", weave, { webviewOptions: { retainContextWhenHidden: true } }));
  registerChat(context, weave, out);
  // "Black Window" in the chat model picker: every place's models, keyed from the secret store.
  const provider = new BlackWindowProvider(places, out, weave);
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider("blackwindow", provider));
  context.subscriptions.push(vscode.commands.registerCommand("sunstone.refreshModels", () => provider.refresh()));
  registerAssess(context, { weave, provider });
  registerGenerate(context);
  registerJudge(context);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  // The status bar is the memory's: what is woven and whether it is up. The page's own status stays in the Output channel.
  status.command = "sunstone.weave.focus"; status.text = "$(database) Black Window"; status.tooltip = "Black Window memory: nothing woven yet. Click for the Weave view."; status.show();
  const showWeave = () => { const total = [...weave.counts.values()].reduce((a, b) => a + b, 0); status.text = `$(database) ${total ? total.toLocaleString() : "Black Window"}`; status.tooltip = new vscode.MarkdownString(`**Black Window memory**: ${total.toLocaleString()} passages in ${weave.folders.length} folder${weave.folders.length === 1 ? "" : "s"}${weave.folders.map((f) => `\n\n- ${path.basename(f)} (${(weave.counts.get(f) || 0).toLocaleString()})`).join("")}\n\nClick for the Weave view.`); };
  context.subscriptions.push(weave.onDidChange(showWeave));

  context.subscriptions.push(vscode.commands.registerCommand("sunstone.docs", () =>
    vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(path.join(context.extensionPath, "docs", "GUIDE.md")))));

  // Nothing is woven until asked, and the two viewsWelcome entries that say so cannot render:
  // the Places root always returns its two groups, so the view is never empty. Say it here once.
  void (async () => {
    if (weave.folders.length || !(vscode.workspace.workspaceFolders || []).length) return;
    if (context.globalState.get("sunstone.weavePrompted")) return;
    await context.globalState.update("sunstone.weavePrompted", true);
    const pick = await vscode.window.showInformationMessage(
      "Sunstone indexes nothing until you weave a folder. Until then the models cannot search this workspace.",
      "Weave this folder", "Open the guide", "Not now");
    if (pick === "Weave this folder") await vscode.commands.executeCommand("sunstone.weaveFolder");
    else if (pick === "Open the guide") await vscode.commands.executeCommand("sunstone.docs");
  })();
  let lastReply = "", lastTps: number | null = null, pushing: Promise<void> | null = null;
  context.subscriptions.push(server, host, weave, local, tree, view, out, status);

  // Places go into the page after each hello (first open and any reload) through bw.pair, never through the HTML.
  // Hello comes from the injected script ahead of the page's module, so the first step is waiting for window.bw and
  // the catalog; a reload mid-way (the service worker's first install reloads once) starts a new generation and the
  // old one stops at its next step.
  let gen = 0;
  const pushPlaces = () => { const my = ++gen; pushing = (async () => {
    const alive = () => my === gen && host.isOpen;
    await waitTiles(host, 60_000, alive);
    if (!alive()) return;
    const list = await places.withKeys();
    for (const p of list.filter((p) => p.enabled !== false)) {
      if (!alive()) return;
      try { await host.bw("pair", [p.url, p.name, p.key], 30_000); } catch (e: any) { out.appendLine(`place ${p.name}: ${e.message || e}`); }
    }
    const want = vscode.workspace.getConfiguration("sunstone").get<string>("model") || "";
    if (want) {
      // A place's tiles appear once the page has asked it; a name is matched against those, an id against any tile.
      const find = (tiles: { id: string; name: string }[]) => tiles.find((t) => t.id === want) || tiles.find((t) => t.id.endsWith("|" + want)) || tiles.find((t) => t.name.split(" \u00b7 ")[0] === want);
      const t0 = Date.now(); let tile;
      while (alive() && !(tile = find(await host.bw<any[]>("tiles", [], 10_000).catch(() => []))) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 1000));
      if (!alive()) return;
      if (tile) { try { await host.bw("pick", [tile.id], 30_000); } catch (e: any) { out.appendLine(`pick ${want}: ${e.message || e}`); } }
      else out.appendLine(`model ${want}: no tile for it (places: ${list.map((p) => p.name).join(", ") || "none"})`);
    }
  })().catch((e) => out.appendLine(String(e))).finally(() => { if (my === gen) pushing = null; }); };
  context.subscriptions.push(host.onHello(() => { pushPlaces(); }));

  context.subscriptions.push(host.onMessage((m) => {
    if (!m) return;
    if (m.sun === "event") {
      events.push(m);
      if (m.kind === "log") out.appendLine(m.line);
      else if (m.kind === "status") { /* the page's own status: Output channel only */ }
      else if (m.kind === "turn") { lastReply = m.reply || ""; lastTps = m.tps; }
      else if (m.kind === "boxes") places.fromPage(m.boxes || []).catch((e) => out.appendLine(String(e)));
      if (m.kind === "status" && /^ready/.test(m.text || "")) host.eval<string>(`return window.bw.modelId || "";`, 5000).then((id) => { if (id && id !== tree.current) { tree.current = id; tree.refresh(); } }).catch(() => {});
    } else if (m.sun === "error" || m.sun === "rejection") out.appendLine(`page ${m.sun}: ${m.message}`);
  }));

  const open = async () => { await host.open(); };
  const ask = async (text: string, timeoutMs = 600_000) => { await open(); const r = await host.bw<any>("ask", [text], timeoutMs); lastReply = r?.reply || lastReply; return r; };
  const pick = async (id: string, timeoutMs = 1_800_000) => {
    await open(); if (pushing) await pushing;
    const before = await host.eval<string>(`return (document.querySelector("#status")?.textContent || "").trim();`, 5000).catch(() => "");
    await host.bw("pick", [id], 30_000); tree.current = id; tree.refresh();
    await waitReady(host, timeoutMs, before); tree.refresh();
  };
  // A place that is not in the page yet (found on a port, or the local server) is saved and paired before its tile can exist.
  const ensurePlace = async (p: { name: string; url: string }, key: string) => {
    if (!places.list().some((x) => x.url === p.url)) await places.add({ name: p.name, url: p.url, key });
    await open(); if (pushing) await pushing;
    const known = await host.bw<{ url: string }[]>("places", [], 10_000).catch(() => []);
    if (!known.some((x) => x.url === p.url)) await host.bw("pair", [p.url, p.name, key || (await places.key(p.url))], 30_000);
  };
  const waitTile = async (id: string, ms = 60_000) => { const t0 = Date.now(); for (;;) { const tiles = await host.bw<{ id: string }[]>("tiles", [], 10_000).catch(() => []); if (tiles.some((t) => t.id === id)) return true; if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 1000)); } };

  context.subscriptions.push(
    vscode.commands.registerCommand("sunstone.openChat", open),
    vscode.commands.registerCommand("sunstone.pair", async () => {
      const spec = await vscode.window.showInputBox({ title: "Sunstone: add a place", prompt: "A BLACK WINDOW pairing line, its link, or the URL of an OpenAI-compatible server", ignoreFocusOut: true });
      if (!spec) return;
      let p: { url: string; key: string; name: string };
      try { p = parsePairing(spec); } catch (e: any) { return void vscode.window.showErrorMessage(e.message); }
      if (!p.key) p.key = (await vscode.window.showInputBox({ title: "Sunstone: the server's api key", prompt: `Key for ${p.url} (leave empty if it has none)`, password: true, ignoreFocusOut: true })) || "";
      const name = await vscode.window.showInputBox({ title: "Sunstone: name for this place", value: p.name || autoName(p.url), ignoreFocusOut: true });
      const saved = await places.add({ name: name || p.name || autoName(p.url), url: p.url, key: p.key });
      vscode.window.setStatusBarMessage(`Sunstone: ${saved.name} saved`, 4000);
      if (host.isOpen) { try { await host.bw("pair", [saved.url, saved.name, p.key], 30_000); } catch (e: any) { out.appendLine(`place ${saved.name}: ${e.message || e}`); } }
      else await open();
    }),
    vscode.commands.registerCommand("sunstone.removePlace", async () => {
      const list = places.list(); if (!list.length) return void vscode.window.showInformationMessage("Sunstone: no places saved.");
      const pickd = await vscode.window.showQuickPick(list.map((p) => ({ label: p.name, description: p.url, url: p.url })), { title: "Sunstone: remove a place" });
      if (pickd) { await places.remove(pickd.url); vscode.window.setStatusBarMessage(`Sunstone: ${pickd.label} removed`, 4000); }
    }),
    vscode.commands.registerCommand("sunstone.pickModel", async () => {
      await open(); if (pushing) await pushing;
      const tiles = await waitTiles(host, 20_000);
      if (!tiles.length) return void vscode.window.showInformationMessage("Sunstone: the catalog is still building; try again in a moment.");
      const choice = await vscode.window.showQuickPick(tiles.map((t) => ({ label: t.name, description: t.tag, detail: t.why.slice(0, 120), id: t.id })), { title: "Sunstone: load a model", matchOnDetail: true });
      if (!choice) return;
      await vscode.workspace.getConfiguration("sunstone").update("model", choice.id, vscode.ConfigurationTarget.Global);
      pick(choice.id).catch((e) => vscode.window.showErrorMessage(`Sunstone: ${e.message || e}`));
    }),
    vscode.commands.registerCommand("sunstone.askSelection", async () => {
      const ed = vscode.window.activeTextEditor;
      const sel = ed && !ed.selection.isEmpty ? ed.document.getText(ed.selection) : ed?.document.getText() || "";
      const name = ed ? path.basename(ed.document.fileName) + (ed.selection.isEmpty ? "" : `:${ed.selection.start.line + 1}-${ed.selection.end.line + 1}`) : "";
      const q = await vscode.window.showInputBox({ title: sel ? `Sunstone: ask about ${name}` : "Sunstone: ask", prompt: sel ? `${sel.length.toLocaleString()} characters go in as material` : "", ignoreFocusOut: true });
      if (!q) return;
      await open();
      if (sel) await host.bw("attach", [name, sel], 120_000);
      const r = await ask(q).catch((e) => ({ reply: "", error: e.message || String(e) }));
      if (r.error) vscode.window.showErrorMessage(`Sunstone: ${r.error}`);
    }),
    vscode.commands.registerCommand("sunstone.insertReply", async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return void vscode.window.showInformationMessage("Sunstone: no editor to insert into.");
      if (!lastReply) return void vscode.window.showInformationMessage("Sunstone: no reply yet.");
      await ed.edit((b) => b.replace(ed.selection, lastReply));
    }),
    vscode.commands.registerCommand("sunstone.weaveFolder", async (uri?: vscode.Uri) => {
      let folder = uri;
      if (!folder) {
        const ws = vscode.workspace.workspaceFolders || [];
        const choice = ws.length === 1 ? { uri: ws[0].uri } : await vscode.window.showQuickPick(ws.map((w) => ({ label: w.name, description: w.uri.fsPath, uri: w.uri })), { title: "Black Window: weave which folder?" });
        folder = choice?.uri;
      }
      if (!folder) return;
      try { const r = await weave.indexFolder(folder); vscode.window.setStatusBarMessage(`Black Window: wove ${path.basename(folder.fsPath)}: ${r.files} files, ${r.passages.toLocaleString()} passages`, 6000); }
      catch (e: any) { vscode.window.showErrorMessage(`Black Window: ${e.message || e}`); }
    }),
    vscode.commands.registerCommand("sunstone.forgetSources", async (prefix?: string) => {
      if (!prefix) return 0;
      const n = await weave.forgetSources(prefix);
      vscode.window.setStatusBarMessage(`Black Window: forgot ${n} source${n === 1 ? "" : "s"} under ${prefix}`, 6000);
      return n;
    }),
    vscode.commands.registerCommand("sunstone.forgetFolder", async (folderPath?: string) => {
      const list = weave.folders; if (!list.length) return void vscode.window.showInformationMessage("Black Window: no folders woven.");
      if (folderPath && list.includes(folderPath)) return void await weave.forgetFolder(folderPath);
      const c = await vscode.window.showQuickPick(list.map((f) => ({ label: path.basename(f), description: f, f })), { title: "Black Window: forget which folder?" });
      if (c) await weave.forgetFolder(c.f);
    }),
    vscode.commands.registerCommand("sunstone.weaveSearch", async () => {
      const q = await vscode.window.showInputBox({ title: "Black Window: search the weave", ignoreFocusOut: true }); if (!q) return;
      const hits = await weave.search(q, 12).catch((e) => { vscode.window.showErrorMessage(`Black Window: ${e.message || e}`); return []; });
      if (!hits.length) return void vscode.window.showInformationMessage("Black Window: nothing matched.");
      const c = await vscode.window.showQuickPick(hits.map((h) => ({ label: h.source, description: h.score.toFixed(2), detail: h.text.slice(0, 160).replace(/\s+/g, " "), h })), { title: `${hits.length} passages`, matchOnDetail: true });
      const u = c && weave.fileOf(c.h.source); if (u) vscode.window.showTextDocument(u);
    }),
    vscode.commands.registerCommand("sunstone.openPack", async (uri?: vscode.Uri) => {
      const pick = uri ? [uri] : await vscode.window.showOpenDialog({ title: "Black Window: open a weave pack", filters: { "weave pack": ["json"] }, canSelectMany: false });
      if (!pick?.length) return;
      try { const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Black Window: opening ${path.basename(pick[0].fsPath)}` }, () => weave.openPack(pick[0])); vscode.window.setStatusBarMessage(`Black Window: pack ${r.name}: ${r.passages.toLocaleString()} passages${r.direct ? "" : " (re-embedded)"}`, 8000); }
      catch (e: any) { vscode.window.showErrorMessage(`Black Window: ${e.message || e}`); }
    }),
    vscode.commands.registerCommand("sunstone.savePack", async () => {
      const sources = await weave.host.bw<{ source: string; passages: number }[]>("sources", []).catch(() => []);
      const packs = sources.filter((s) => s.source.startsWith("pack:"));
      if (!packs.length) return void vscode.window.showInformationMessage("Black Window: no packs in the weave (packs are sources named pack:<name>).");
      const c = await vscode.window.showQuickPick(packs.map((s) => ({ label: s.source.slice(5), description: `${s.passages.toLocaleString()} passages` })), { title: "Black Window: save which pack?" });
      if (!c) return;
      const file = await vscode.window.showSaveDialog({ title: "Black Window: save the pack", defaultUri: vscode.Uri.file(path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.env.HOME || "", `${c.label}.pack.json`)), filters: { "weave pack": ["json"] } });
      if (!file) return;
      const r = await weave.exportPack(c.label, file);
      vscode.window.setStatusBarMessage(`Black Window: saved ${c.label}: ${r.passages.toLocaleString()} passages, ${(r.bytes / 1048576).toFixed(1)} MB`, 8000);
    }),
    vscode.commands.registerCommand("sunstone.refreshPlaces", () => tree.refresh()),
    vscode.commands.registerCommand("sunstone.startLocal", async () => {
      try {
        const r = await vscode.window.withProgress({ location: { viewId: "sunstone.places" }, title: "starting llama-server" }, () => local.start());
        await places.add({ name: "local", url: r.url, key: r.key });
        vscode.window.setStatusBarMessage(`Sunstone: llama-server up on ${local.port} with ${r.models.length} models`, 5000);
        if (host.isOpen) await host.bw("pair", [r.url, "local", r.key], 30_000).catch((e: any) => out.appendLine(`local: ${e.message || e}`));
      } catch (e: any) { vscode.window.showErrorMessage(`Sunstone: ${e.message || e}`); }
      tree.refresh();
    }),
    vscode.commands.registerCommand("sunstone.stopLocal", () => { local.stop(); tree.refresh(); }),
    vscode.commands.registerCommand("sunstone.removePlaceNode", async (n: Node) => { if (n?.kind === "place") { await places.remove(n.place.url); tree.refresh(); } }),
    // Loading from the tree talks to the router itself: no page opens. The model then answers in the chat picker.
    vscode.commands.registerCommand("sunstone.loadModel", async (n: Node) => {
      if (!n || n.kind !== "model") return;
      const key = n.place.url === local.url ? await local.getKey() : await places.key(n.place.url);
      const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
      try {
        if (!n.router) { vscode.window.showInformationMessage(`${n.place.name} serves ${n.model}; pick "${n.model} \u00b7 ${n.place.name}" in the chat model picker.`); return; }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${n.model} loading on ${n.place.name}`, cancellable: true }, async (progress, ct) => {
          const r = await fetch(`${n.place.url}/models/load`, { method: "POST", headers, body: JSON.stringify({ model: n.model }) });
          if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
          const t0 = Date.now();
          for (;;) {
            if (ct.isCancellationRequested) return;
            await new Promise((res) => setTimeout(res, 2000));
            const list: any = await (await fetch(`${n.place.url}/models`, { headers })).json();
            const me = (list.data || []).find((x: any) => x.id === n.model);
            const st = me?.status?.value || "";
            progress.report({ message: `${st || "asked"} \u00b7 ${Math.round((Date.now() - t0) / 1000)} s` });
            if (st === "loaded") break;
            if (me?.status?.failed || (st === "unloaded" && Date.now() - t0 > 60_000)) throw new Error(`${n.model} did not load (${st}); see the box's log`);
            if (Date.now() - t0 > 1_800_000) throw new Error("still loading after 30 minutes");
          }
        });
        provider.refresh(); tree.refresh();
        vscode.window.setStatusBarMessage(`${n.model} is serving on ${n.place.name}: pick "${n.model} \u00b7 ${n.place.name}" in the chat model picker`, 8000);
      } catch (e: any) { vscode.window.showErrorMessage(`Sunstone: ${e.message || e}`); }
      tree.refresh();
    }),
    // A box holds more than it serves: the router downloads a model from Hugging Face on its own disk, and it is in
    // the chat picker as soon as it is there. The catalog beside the page is the suggestion list; any repo is allowed.
    vscode.commands.registerCommand("sunstone.addModel", async (n?: Node) => {
      const routers = places.list().filter((p) => tree.probeOf(p.url)?.router);
      let place = n?.kind === "place" ? n.place : n?.kind === "model" ? n.place : undefined;
      if (place && !tree.probeOf(place.url)?.router) return void vscode.window.showInformationMessage(`${place.name} serves one model and cannot be given another. A box in llama-server's router mode can.`);
      if (!place) {
        if (!routers.length) return void vscode.window.showInformationMessage("Sunstone: no place is a llama-server router (started with --models-preset or --models-dir), so there is nowhere to put a model.");
        const c = routers.length === 1 ? { place: routers[0] } : await vscode.window.showQuickPick(routers.map((p) => ({ label: p.name, description: p.url, place: p })), { title: "Sunstone: put a model on which box?" });
        place = c?.place;
      }
      if (!place) return;
      const held = new Set((tree.probeOf(place.url)?.models || []).map((m) => m.id.toLowerCase()));
      let catalog: any[] = [];
      try { catalog = JSON.parse(fs.readFileSync(path.join(context.extensionPath, "media", "catalog.json"), "utf8")); } catch (e: any) { out.appendLine(`catalog: ${e.message || e}`); }
      const rows = catalog
        .filter((m) => m.repo && (m.role || "chat") === "chat")
        .map((m) => ({ label: m.name, repo: `${m.repo}${m.quant ? `:${m.quant}` : ""}`, description: `${(m.size_mb / 1024).toFixed(1)} GB${m.active_b && m.active_b < m.params_b ? `, ${m.active_b}B active of ${m.params_b}B` : `, ${m.params_b}B`}`, detail: `${m.repo}${m.quant ? `:${m.quant}` : ""}` }))
        .filter((r) => !held.has(r.repo.toLowerCase()))
        .sort((a, b) => a.label.localeCompare(b.label));
      const typed = { label: "$(edit) a Hugging Face repo\u2026", repo: "", description: "user/model-GGUF:QUANT", detail: "" };
      const c = await vscode.window.showQuickPick([typed, ...rows], { title: `Sunstone: add a model to ${place.name}`, matchOnDetail: true, placeHolder: "the box downloads it itself; nothing is uploaded from here" });
      if (!c) return;
      const repo = c.repo || (await vscode.window.showInputBox({ title: `Sunstone: add a model to ${place.name}`, prompt: "Hugging Face repo, quant optional (Q4_K_M by default)", placeHolder: "unsloth/GLM-4.7-Flash-GGUF:Q4_K_M", ignoreFocusOut: true }))?.trim();
      if (!repo) return;
      const key = place.url === local.url ? await local.getKey() : await places.key(place.url);
      const here = place;
      try {
        const id = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${repo} downloading on ${here.name}`, cancellable: true }, (progress, ct) =>
          addModel(here.url, key, repo, (m) => progress.report({ message: m }), () => ct.isCancellationRequested));
        provider.refresh(); tree.refresh();
        vscode.window.showInformationMessage(`${id} is on ${here.name}. Pick "${id.split("/").pop()} \u00b7 ${here.name}" in the chat model picker; it loads on first use.`);
      } catch (e: any) { vscode.window.showErrorMessage(`Sunstone: ${e.message || e}`); }
      tree.refresh();
    }),
    // The standalone page still loads a model the old way, for whoever wants the page itself.
    vscode.commands.registerCommand("sunstone.loadModelInPage", async (n: Node) => {
      if (!n || n.kind !== "model") return;
      const id = tileId(n.place.url, n.model, n.router);
      try {
        await ensurePlace(n.place, n.place.url === local.url ? await local.getKey() : "");
        if (!(await waitTile(id))) throw new Error(`${n.model} has no tile in the catalog yet (is ${n.place.name} answering?)`);
        await vscode.workspace.getConfiguration("sunstone").update("model", id, vscode.ConfigurationTarget.Global);
        await pick(id);
      } catch (e: any) { vscode.window.showErrorMessage(`Sunstone: ${e.message || e}`); }
      tree.refresh();
    }),
  );

  return { host, weave, places, local, tree, provider, open, ask, pick, waitReady: (ms) => waitReady(host, ms), events, lastReply: () => lastReply };
}

export async function waitTiles(host: Host, ms: number, alive: () => boolean = () => true): Promise<{ id: string; name: string; tag: string; why: string }[]> {
  const t0 = Date.now();
  for (;;) {
    const tiles = await host.eval<{ id: string; name: string; tag: string; why: string }[]>(`return window.bw && window.bw.tiles ? window.bw.tiles() : [];`, 5_000).catch(() => []);
    if (tiles.length || Date.now() - t0 > ms || !alive()) return tiles;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export async function waitReady(host: Host, ms = 600_000, before = ""): Promise<string> {
  const t0 = Date.now(); let moved = !before;
  for (;;) {
    const s = await host.eval<string>(`return (document.querySelector("#status")?.textContent || "").trim();`, 10_000).catch(() => "");
    // Right after a pick the status still reads the previous model's ready for a moment; that one does not count.
    if (!moved && s !== before) moved = true;
    if (!moved && Date.now() - t0 > 15_000) moved = true;
    if (moved && /^ready/i.test(s)) return s;
    if (moved && /failed|error/i.test(s)) throw new Error(s);
    if (Date.now() - t0 > ms) throw new Error(`not ready after ${Math.round(ms / 1000)} s (${s || "no status"})`);
    await new Promise((r) => setTimeout(r, moved ? 2000 : 300));
  }
}

export function deactivate() {}
