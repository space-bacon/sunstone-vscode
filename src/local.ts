import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, ChildProcess, execFileSync } from "child_process";
import { probe } from "./probe";
import { readGguf, kvBytesPerToken } from "./gguf";

// A llama-server on this machine, started by Sunstone in router mode over the GGUFs it finds: the same shape as a
// box (one model loaded at a time, load on pick), keyed, bound to 127.0.0.1. The preset follows research/bench/
// box_preset.py: window, flash attention, jinja, an mmproj attached when one sits beside the model.

export interface LocalModel { name: string; file: string; sizeGb: number; mmproj?: string }

const QUANT_RE = /[-_.](?:UD-)?(?:I?Q\d[A-Z0-9_]*|f16|bf16|F16|BF16|fp16|Q\d)(?:[-_.][A-Za-z0-9_]+)*$/;

export function defaultModelDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "xyz.blackwindow.app", "models"),
    path.join(home, ".cache", "llama.cpp"),
    path.join(home, "models"),
  ].filter((d) => fs.existsSync(d));
}

export function scanModels(dirs: string[]): LocalModel[] {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[] = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 3 && !e.name.startsWith(".")) walk(p, depth + 1); else if (e.isFile() && /\.gguf$/i.test(e.name)) files.push(p); }
  };
  for (const d of dirs) walk(d, 0);
  const isProj = (f: string) => /mmproj/i.test(path.basename(f));
  const isAux = (f: string) => /ggml-vocab|bge-|embed|e5-|minilm|whisper|rerank/i.test(path.basename(f));
  const models: LocalModel[] = [];
  for (const f of files) {
    const b = path.basename(f, ".gguf");
    if (isProj(f) || isAux(f)) continue;
    // Split files: only the first part is the model.
    const part = b.match(/-(\d{5})-of-\d{5}$/); if (part && part[1] !== "00001") continue;
    const name = b.replace(/-\d{5}-of-\d{5}$/, "").replace(QUANT_RE, "").replace(/-GGUF$/i, "").replace(/^(microsoft_|Meta-)/, "");
    const stem = name.toLowerCase();
    const mmproj = files.find((g) => isProj(g) && path.dirname(g) === path.dirname(f) && path.basename(g).toLowerCase().startsWith(stem));
    let size = 0; try { size = fs.statSync(f).size; } catch {}
    if (part) { const dir = path.dirname(f), pre = b.replace(/-\d{5}-of-\d{5}$/, ""); for (const g of files) if (path.dirname(g) === dir && path.basename(g).startsWith(pre + "-") && g !== f) { try { size += fs.statSync(g).size; } catch {} } }
    models.push({ name, file: f, sizeGb: Math.round(size / 1e8) / 10, mmproj });
  }
  models.sort((a, b) => a.sizeGb - b.sizeGb);
  return models;
}

export function writePreset(models: LocalModel[], file: string, ctx: number): string {
  const ramGb = os.totalmem() / 1e9;
  // Unified memory on a Mac: weights and KV come out of the same pool, so a model's window is what is left after its
  // weights, measured from its own KV cost, rather than a fixed number keyed on a size threshold.
  const pool = ramGb * 0.7;
  const lines = ["version = 1", "", "[*]", `c = ${ctx}`, "flash-attn = on", "jinja = true", "cache-ram = 4096", "cache-reuse = 256", ""];
  for (const m of models) {
    lines.push(`[${m.name}]`, `model = ${m.file}`);
    if (m.mmproj) lines.push(`mmproj = ${m.mmproj}`);
    const g = readGguf(m.file);
    const perTok = kvBytesPerToken(g);
    const spare = Math.max(0, pool - m.sizeGb) * 1e9;
    // What memory allows, rounded down to 4K and floored there, then capped by what the model was trained for.
    const win = perTok > 0
      ? Math.min(ctx, g!.trained || ctx, Math.max(4096, Math.floor(spare / perTok / 4096) * 4096))
      : Math.min(ctx, m.sizeGb > pool * 0.7 ? 16384 : ctx);
    if (win !== ctx) lines.push(`c = ${win}`);
    if (m.sizeGb > pool * 0.7) lines.push("fit = on"); else lines.push("n-gpu-layers = 999");
    lines.push(`; ${m.sizeGb} GB on disk${perTok ? `, KV ${(perTok / 1024).toFixed(1)} KB a token, ${(win * perTok / 1e9).toFixed(1)} GB at ${win}` : ", KV cost unknown"}`, "");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n"));
  return file;
}

export function findBinary(configured: string): string {
  if (configured && fs.existsSync(configured)) return configured;
  try { const w = execFileSync("/usr/bin/which", ["llama-server"], { encoding: "utf8" }).trim(); if (w) return w; } catch {}
  for (const c of ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server", path.join(os.homedir(), ".local", "bin", "llama-server")]) if (fs.existsSync(c)) return c;
  return "";
}

export class LocalServer implements vscode.Disposable {
  private child: ChildProcess | undefined;
  readonly out = vscode.window.createOutputChannel("llama-server");
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  models: LocalModel[] = [];
  key = "";
  startedAt = 0;

  constructor(private readonly context: vscode.ExtensionContext) {}

  get cfg() { return vscode.workspace.getConfiguration("sunstone.local"); }
  get port(): number { return this.cfg.get<number>("port") || 8083; }
  get url(): string { return `http://127.0.0.1:${this.port}`; }
  get binary(): string { return findBinary(this.cfg.get<string>("llamaServer") || ""); }
  get dirs(): string[] { const d = this.cfg.get<string[]>("modelDirs") || []; return d.length ? d.map((x) => x.replace(/^~/, os.homedir())).filter((x) => fs.existsSync(x)) : defaultModelDirs(); }
  get running(): boolean { return !!this.child && this.child.exitCode === null; }

  scan(): LocalModel[] { this.models = scanModels(this.dirs); return this.models; }

  async getKey(): Promise<string> {
    if (this.key) return this.key;
    let k = await this.context.secrets.get("sunstone.local.key");
    if (!k) { k = crypto.randomBytes(16).toString("hex"); await this.context.secrets.store("sunstone.local.key", k); }
    return this.key = k;
  }

  async start(): Promise<{ url: string; key: string; models: LocalModel[] }> {
    const bin = this.binary;
    if (!bin) throw new Error("llama-server was not found. Install llama.cpp (macOS: brew install llama.cpp) or set sunstone.local.llamaServer to the binary.");
    const models = this.scan();
    if (!models.length) throw new Error(`no .gguf files under ${this.dirs.join(", ") || "the model directories"}; set sunstone.local.modelDirs.`);
    // Something already answering on the port is left alone and used as is.
    const already = await probe(this.url, await this.getKey(), 1500);
    if (already.up) { this.startedAt = this.startedAt || Date.now(); return { url: this.url, key: this.key, models }; }
    const preset = writePreset(models, path.join(this.context.globalStorageUri.fsPath, "models.ini"), this.cfg.get<number>("ctx") || 32768);
    const key = await this.getKey();
    const args = ["--models-preset", preset, "--models-max", "1", "--host", "127.0.0.1", "--port", String(this.port), "--api-key", key, "--no-webui"];
    this.out.appendLine(`${bin} ${args.map((a) => a === key ? "<key>" : a).join(" ")}`);
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LLAMA_CACHE: path.join(this.context.globalStorageUri.fsPath, "llama-cache-empty") } });
    this.child = child; this.startedAt = Date.now();
    child.stdout?.on("data", (d) => this.out.append(String(d)));
    child.stderr?.on("data", (d) => this.out.append(String(d)));
    child.on("exit", (code, sig) => { this.out.appendLine(`llama-server exited (${code ?? sig})`); if (this.child === child) this.child = undefined; this.changed.fire(); });
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      if (child.exitCode !== null) throw new Error(`llama-server exited with ${child.exitCode}; see the llama-server output channel`);
      const p = await probe(this.url, key, 1500);
      if (p.up) { this.changed.fire(); return { url: this.url, key, models }; }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("llama-server did not answer within 60 s; see the llama-server output channel");
  }

  stop(): void {
    const c = this.child; if (!c) return;
    c.kill("SIGTERM"); setTimeout(() => { if (c.exitCode === null) c.kill("SIGKILL"); }, 5000);
    this.child = undefined; this.changed.fire();
  }

  dispose(): void { this.stop(); this.out.dispose(); }
}
