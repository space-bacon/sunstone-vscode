import * as vscode from "vscode";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import * as crypto from "crypto";

// The Black Window engine build (media/) is served by a loopback HTTP server and shown in the webview inside an
// iframe. The webview's own resource scheme cannot feed a Worker (VS Code's service worker answers 408 to a worker's
// fetch, module imports from a blob worker fail, and a blob URL has no base for wasm-bindgen's new URL()), so the page
// runs on a real http://127.0.0.1 origin, which Chromium treats as secure: workers, wasm, the page's service worker,
// WebGPU and fetch all behave as on blackwindow.xyz. The bridge is two postMessage hops: extension -> webview shell ->
// iframe page, and back. The page runs in host mode (window.SUNSTONE set before its module): it keeps no boxes or
// keys in its own storage and reports log lines, status and turn stats here.

export interface PageEvent { sun: "event"; kind: "log" | "status" | "turn" | "boxes"; [k: string]: any }

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".ico": "image/x-icon", ".svg": "image/svg+xml", ".bin": "application/octet-stream", ".safetensors": "application/octet-stream",
  ".srtidx": "application/octet-stream", ".txt": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8",
};

// Runs inside the page (injected into index.html by the server, ahead of the page's module): puts the page in host
// mode, answers eval requests from the shell, forwards page errors, and says hello.
function pageScript(): string {
  return `<script>
(() => {
  const send = (m) => parent.postMessage(m, "*");
  window.SUNSTONE = { boxes: [], vast_key: "", post: send };
  window.addEventListener("message", (e) => {
    const m = e.data; if (!m || m.sun !== "eval") return;
    (async () => {
      try { const value = await (0, eval)("(async () => { " + m.code + " })()"); send({ sun: "result", id: m.id, ok: true, value }); }
      catch (err) { send({ sun: "result", id: m.id, ok: false, error: String((err && err.stack) || err) }); }
    })();
  });
  window.addEventListener("error", (e) => send({ sun: "error", message: String(e.message), source: String(e.filename || ""), line: e.lineno, col: e.colno, stack: String((e.error && e.error.stack) || "").slice(0, 600) }));
  window.addEventListener("unhandledrejection", (e) => send({ sun: "rejection", message: String((e.reason && (e.reason.stack || e.reason.message)) || e.reason) }));
  send({ sun: "hello", gpu: !!navigator.gpu, ua: navigator.userAgent, origin: location.origin, href: location.href, secure: window.isSecureContext });
})();
</script>`;
}

// The webview document: an iframe on the loopback page and a relay between the extension and the frame. In service
// mode the frame is kept alive but out of sight (1 px, not display:none, so its workers and WebGPU keep running) and
// the view shows a status panel the extension fills: what is woven, how much, whether the memory is up.
function shellHtml(pageUrl: string, frameOrigin: string, service = false): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameOrigin}; script-src 'nonce-sun'; style-src 'unsafe-inline'; img-src data:;">
<style>
  html,body{margin:0;height:100%;background:${service ? "transparent" : "#131233"};color:var(--vscode-foreground);font:12px var(--vscode-font-family)}
  iframe{border:0;width:100%;height:100%;display:block}
  ${service ? `iframe{position:absolute;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none}
  .p{padding:8px 12px 12px}.h{display:flex;align-items:center;gap:8px;margin-bottom:8px}.dot{width:8px;height:8px;border-radius:50%;background:var(--vscode-charts-yellow)}.dot.on{background:var(--vscode-charts-green)}.dot.off{background:var(--vscode-errorForeground)}
  .n{font-weight:600}.m{color:var(--vscode-descriptionForeground)}.f{display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid var(--vscode-widget-border,rgba(128,128,128,.2))}.f:first-of-type{border-top:0}
  .f .path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.f .c{color:var(--vscode-descriptionForeground);white-space:nowrap}
  button{margin:8px 6px 0 0;padding:3px 8px;border:1px solid var(--vscode-button-border,transparent);border-radius:2px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer;font:inherit}button:hover{background:var(--vscode-button-secondaryHoverBackground)}
  .x{cursor:pointer;color:var(--vscode-descriptionForeground);margin-left:6px}.x:hover{color:var(--vscode-errorForeground)}.log{margin-top:8px;color:var(--vscode-descriptionForeground);font-size:11px;white-space:pre-wrap}` : ""}
</style></head>
<body>${service ? `<div class="p" id="panel"><div class="h"><span class="dot" id="dot"></span><span class="n" id="title">memory starting</span></div><div id="folders" class="m">no folders woven yet</div><div><button data-cmd="sunstone.weaveFolder">weave a folder</button><button data-cmd="sunstone.weaveSearch">search</button><button data-cmd="sunstone.openChat">open the page</button></div><div class="log" id="log"></div></div>` : ""}<iframe id="f" src="${pageUrl}" allow="cross-origin-isolated; clipboard-read; clipboard-write; microphone; camera"></iframe>
<script nonce="sun">
  const vscode = acquireVsCodeApi(); const f = document.getElementById("f");
  window.addEventListener("message", (e) => {
    if (e.source === f.contentWindow) { vscode.postMessage(e.data); return; }
    const m = e.data; if (!m) return;
    if (m.sun === "eval") f.contentWindow.postMessage(m, ${JSON.stringify(frameOrigin)});
    if (m.sun === "panel" && ${service}) render(m);
  });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function render(m) {
    const dot = document.getElementById("dot"); dot.className = "dot " + (m.state === "ready" ? "on" : m.state === "error" ? "off" : "");
    document.getElementById("title").textContent = m.title || "";
    const fs = document.getElementById("folders");
    fs.innerHTML = (m.folders || []).length ? m.folders.map((x) => \`<div class="f"><span class="path" title="\${esc(x.path)}">\${esc(x.name)}</span><span class="c">\${x.count == null ? "" : Number(x.count).toLocaleString() + " passages"}<span class="x" data-forget="\${esc(x.path)}" title="forget this folder">\u2715</span></span></div>\`).join("") : "no folders woven yet";
    document.getElementById("log").textContent = m.log || "";
  }
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cmd]"); if (b) vscode.postMessage({ sun: "cmd", command: b.dataset.cmd });
    const x = e.target.closest("[data-forget]"); if (x) vscode.postMessage({ sun: "cmd", command: "sunstone.forgetFolder", args: [x.dataset.forget] });
  });
</script></body></html>`;
}

// One loopback server per extension host serves media/ to every page (the chat panel, the weave service).
export class PageServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private base = "";
  origin = "";
  constructor(private readonly root: string, private readonly port = 0) {}

  /** The page URL (index.html under the token path), starting the server on first use. */
  async url(query = ""): Promise<string> {
    if (!this.server) await this.start();
    return `${this.base}index.html${query}`;
  }

  private async start(): Promise<void> {
    const root = this.root, token = crypto.randomBytes(8).toString("hex"), inject = pageScript();
    this.server = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://127.0.0.1");
      if (!u.pathname.startsWith(`/${token}/`)) { res.writeHead(404); return res.end(); }
      let rel = decodeURIComponent(u.pathname.slice(token.length + 2)) || "index.html";
      if (rel.endsWith("/")) rel += "index.html";
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
      const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
      res.setHeader("content-type", type); res.setHeader("cache-control", "no-cache");
      if (rel === "index.html") { const html = fs.readFileSync(file, "utf8").replace(/<head>/i, `<head>${inject}`); res.writeHead(200); return res.end(html); }
      if (req.method === "HEAD") { res.setHeader("content-length", fs.statSync(file).size); res.writeHead(200); return res.end(); }
      res.writeHead(200); fs.createReadStream(file).pipe(res);
    });
    // A stable port keeps the page's origin, and with it the caches that hold model weights and the page's settings,
    // from one session to the next; a busy port falls back to a free one.
    await new Promise<void>((resolve) => {
      const onErr = () => { this.server!.removeListener("error", onErr); this.server!.listen(0, "127.0.0.1", () => resolve()); };
      this.server!.once("error", onErr);
      this.server!.listen(this.port, "127.0.0.1", () => { this.server!.removeListener("error", onErr); resolve(); });
    });
    const port = (this.server.address() as any).port;
    this.origin = `http://127.0.0.1:${port}`;
    this.base = `${this.origin}/${token}/`;
  }

  dispose(): void { this.server?.close(); this.server = undefined; this.base = ""; this.origin = ""; }
}

// A page in a webview: the chat in an editor panel, or the weave service in a sidebar view. Same bridge either way.
export class Host implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private view: vscode.WebviewView | undefined;
  readonly messages: any[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private readonly onMessageEmitter = new vscode.EventEmitter<any>();
  private readonly onOpenEmitter = new vscode.EventEmitter<void>();
  readonly onMessage = this.onMessageEmitter.event;
  /** Fires when a page has said hello (a fresh document: first open, or a reload). */
  readonly onHello = this.onOpenEmitter.event;

  constructor(private readonly server: PageServer, private readonly query = "", private readonly service = false) {}

  get isOpen(): boolean { return !!(this.panel || this.view); }
  private get webview(): vscode.Webview | undefined { return this.panel?.webview || this.view?.webview; }

  private wire(webview: vscode.Webview, onGone: vscode.Event<void>): void {
    webview.onDidReceiveMessage((m) => {
      this.messages.push(m);
      if (m && m.sun === "result" && this.pending.has(m.id)) { const p = this.pending.get(m.id)!; this.pending.delete(m.id); m.ok ? p.resolve(m.value) : p.reject(new Error(m.error)); }
      this.onMessageEmitter.fire(m);
      // A hello is a fresh document: whatever the old one owed will never come.
      if (m && m.sun === "hello") { for (const p of this.pending.values()) p.reject(new Error("the page reloaded")); this.pending.clear(); this.onOpenEmitter.fire(); }
    });
    onGone(() => { this.panel = undefined; this.view = undefined; for (const p of this.pending.values()) p.reject(new Error("the page was closed")); this.pending.clear(); });
  }

  /** The chat in an editor panel beside the current one. */
  async open(): Promise<vscode.WebviewPanel> {
    if (this.panel) { this.panel.reveal(undefined, true); return this.panel; }
    const pageUrl = await this.server.url(this.query);
    const panel = vscode.window.createWebviewPanel("sunstone.chat", "Black Window", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    this.panel = panel;
    this.wire(panel.webview, panel.onDidDispose);
    panel.webview.html = shellHtml(pageUrl, this.server.origin);
    return panel;
  }

  /** The page inside a sidebar WebviewView (resolved by VS Code when the view is first shown). */
  async attach(view: vscode.WebviewView): Promise<void> {
    const pageUrl = await this.server.url(this.query);
    this.view = view;
    view.webview.options = { enableScripts: true };
    this.wire(view.webview, view.onDidDispose);
    view.webview.html = shellHtml(pageUrl, this.server.origin, this.service);
  }

  /** Service mode only: fills the status panel. */
  showPanel(state: { state: "starting" | "ready" | "error"; title: string; folders?: { name: string; path: string; count?: number }[]; log?: string }): void {
    this.webview?.postMessage({ sun: "panel", ...state });
  }

  eval<T = unknown>(code: string, timeoutMs = 60_000): Promise<T> {
    const webview = this.webview;
    if (!webview) return Promise.reject(new Error("the page is not open"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`eval timeout after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      webview.postMessage({ sun: "eval", id, code });
    });
  }

  /** Calls a window.bw method in the page with JSON arguments. */
  bw<T = unknown>(method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<T> {
    return this.eval<T>(`return await window.bw[${JSON.stringify(method)}](...${JSON.stringify(args)});`, timeoutMs);
  }

  dispose(): void { this.panel?.dispose(); this.panel = undefined; this.view = undefined; }
}
