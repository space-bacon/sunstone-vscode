import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

// Black Window's tools for MCP clients outside VS Code (Claude Code, Cursor, anything that launches a stdio server).
// Each window serves its own weave on a Unix socket inside a directory only this user can open, and a bridge script,
// which the client launches, joins the client's stdin and stdout to that socket. There is no port and no key: the
// directory's permissions are the access control, as they are for the weave's own files. The tools are the ones
// VS Code's chat calls, run through vscode.lm.invokeTool, so both kinds of client get one implementation.

const TOOLS = ["blackwindow_weave_search", "blackwindow_lookup", "blackwindow_remember"];
// The versions the reference SDK (1.31) accepts, newest first. A tools-only server answers the same under each.
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const MAX_LINE = 4 * 1024 * 1024;
const INSTRUCTIONS = "Black Window's memory of the user's own folders, served by their VS Code window. Search it with blackwindow_weave_search before grepping when you do not know the file or identifier, and cite the passages you use by their source.";

const BRIDGE = `#!/usr/bin/env node
// Written by Sunstone. Joins an MCP client's stdin and stdout to the weave a VS Code window serves on a Unix socket:
//   node mcp-bridge.js <socket>
const net = require("net");
const s = net.connect(process.argv[2] || "");
s.on("connect", () => { process.stdin.pipe(s); s.pipe(process.stdout); });
s.on("error", (e) => {
  process.stderr.write("sunstone-mcp: " + (e.code === "ENOENT" || e.code === "ECONNREFUSED"
    ? "no VS Code window is serving this weave. Open the workspace in VS Code and run 'Sunstone: Serve the Weave to MCP Clients'."
    : e.message) + "\\n");
  process.exit(1);
});
s.on("close", () => process.exit(0));
`;

type Send = (m: object) => void;

export class McpEndpoint implements vscode.Disposable {
  readonly socket: string;
  readonly bridge: string;
  private server: net.Server | undefined;
  private conns = new Set<net.Socket>();

  constructor(private context: vscode.ExtensionContext, private out: vscode.OutputChannel) {
    // One socket per workspace, named by the workspace's storage folder, so a client configured from a window finds
    // that window again after a restart. The directory is per user; $TMPDIR is already per user on macOS.
    const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `sunstone-mcp-${os.userInfo().uid}`);
    const id = crypto.createHash("sha256").update(context.storageUri?.fsPath || "no-workspace").digest("hex").slice(0, 16);
    this.socket = path.join(dir, `${id}.sock`);
    this.bridge = path.join(context.globalStorageUri.fsPath, "mcp-bridge.js");
  }

  get running(): boolean { return !!this.server?.listening; }

  /** The entry an MCP client's configuration needs: it launches node on the bridge, pointed at this window's socket. */
  config(): { command: string; args: string[] } { return { command: "node", args: [this.bridge, this.socket] }; }

  async start(): Promise<void> {
    if (this.running) return;
    if (process.platform === "win32") throw new Error("serving the weave to MCP clients needs a Unix socket, which this version does not offer on Windows");
    const dir = path.dirname(this.socket);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Refuse a directory someone else made or can read, which on a shared /tmp is how another user would listen in.
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== os.userInfo().uid || (st.mode & 0o077) !== 0) throw new Error(`${dir} is not a directory only this user can open`);
    if (fs.existsSync(this.socket)) {
      const live = await new Promise<boolean>((ok) => { const c = net.connect(this.socket); c.once("connect", () => { c.destroy(); ok(true); }); c.once("error", () => ok(false)); });
      if (live) throw new Error("another VS Code window is already serving this workspace's weave");
      fs.unlinkSync(this.socket);
    }
    this.writeBridge();
    const server = net.createServer((c) => this.serve(c));
    await new Promise<void>((ok, bad) => { server.once("error", bad); server.listen(this.socket, () => { server.off("error", bad); ok(); }); });
    fs.chmodSync(this.socket, 0o600);
    this.server = server;
    this.out.appendLine(`[mcp] serving the weave to MCP clients on ${this.socket}`);
  }

  stop(): void {
    for (const c of this.conns) c.destroy();
    this.conns.clear();
    if (this.server) { this.server.close(); this.server = undefined; try { fs.unlinkSync(this.socket); } catch { /* already gone */ } this.out.appendLine("[mcp] stopped"); }
  }

  dispose(): void { this.stop(); }

  private writeBridge(): void {
    fs.mkdirSync(path.dirname(this.bridge), { recursive: true });
    if (fs.existsSync(this.bridge) && fs.readFileSync(this.bridge, "utf8") === BRIDGE) return;
    fs.writeFileSync(this.bridge + ".tmp", BRIDGE, { mode: 0o755 });
    fs.renameSync(this.bridge + ".tmp", this.bridge);
  }

  /** Newline-delimited JSON-RPC, the framing of MCP's stdio transport, which the bridge passes through unchanged. */
  private serve(c: net.Socket): void {
    this.conns.add(c);
    const pending = new Map<string | number, vscode.CancellationTokenSource>();
    c.on("close", () => { this.conns.delete(c); for (const t of pending.values()) t.cancel(); });
    c.on("error", () => c.destroy());
    const send: Send = (m) => { if (!c.destroyed) c.write(JSON.stringify(m) + "\n"); };
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); continue; }
        for (const m of Array.isArray(msg) ? msg : [msg]) void this.handle(m, send, pending);
      }
      if (buf.length > MAX_LINE) { send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "message too long" } }); c.destroy(); }
    });
  }

  private async handle(m: any, send: Send, pending: Map<string | number, vscode.CancellationTokenSource>): Promise<void> {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return send({ jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "invalid request" } });
    if (typeof m.method !== "string") return; // a response; this server sends no requests
    const { id, method, params } = m;
    if (method === "notifications/cancelled") { pending.get(params?.requestId)?.cancel(); return; }
    if (id === undefined || id === null) return; // notifications/initialized and any other notification
    const reply = (result: object) => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize": {
        const asked = String(params?.protocolVersion || "");
        return reply({
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "sunstone-black-window", title: "Black Window (Sunstone)", version: String(this.context.extension.packageJSON.version || "") },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping": return reply({});
      case "tools/list":
        return reply({ tools: vscode.lm.tools.filter((t) => TOOLS.includes(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema && Object.keys(t.inputSchema).length ? t.inputSchema : { type: "object", properties: {} } })) });
      case "tools/call": {
        const name = String(params?.name || "");
        if (!TOOLS.includes(name)) return fail(-32602, `unknown tool: ${name}`);
        const cts = new vscode.CancellationTokenSource();
        pending.set(id, cts);
        try {
          const r = await vscode.lm.invokeTool(name, { input: params?.arguments && typeof params.arguments === "object" ? params.arguments : {}, toolInvocationToken: undefined }, cts.token);
          const text = r.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : "")).filter(Boolean).join("\n");
          return reply({ content: [{ type: "text", text }] });
        } catch (e: any) {
          return reply({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });
        } finally {
          pending.delete(id);
          cts.dispose();
        }
      }
      default: return fail(-32601, `method not found: ${method}`);
    }
  }
}
