import * as vscode from "vscode";

// A place is somewhere a model runs: for M1, an OpenAI-compatible server (a box behind a tunnel, a llama-server on
// this machine, anything the page takes as "your own server"). Names and URLs live in settings; keys live in
// SecretStorage under the URL, never in settings.json and never in the page's storage.

export interface Place { name: string; url: string; enabled?: boolean }
export interface PlaceWithKey extends Place { key: string }

const SECTION = "sunstone";
const secretKey = (url: string) => `sunstone.key:${url.replace(/\/$/, "")}`;

export function parsePairing(spec: string): { url: string; key: string; name: string } {
  spec = String(spec || "").trim();
  const m = spec.match(/#box=([A-Za-z0-9+/=_-]+)(?:\s|$)/);
  if (m) {
    let j: any; try { j = JSON.parse(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch { throw new Error("the pairing link is damaged; copy the whole BLACK WINDOW line"); }
    if (!/^https?:\/\//.test(j.url || "")) throw new Error("the pairing link has no URL in it");
    return { url: String(j.url).replace(/\/$/, ""), key: String(j.key || ""), name: String(j.name || "") };
  }
  if (/^https?:\/\//.test(spec)) { const u = new URL(spec); return { url: u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")), key: "", name: "" }; }
  throw new Error("paste a BLACK WINDOW pairing line, its link, or an http(s) URL");
}

export function autoName(url: string): string {
  try { const h = new URL(url).host; return /trycloudflare\.com$/.test(h) ? "box" : /^(localhost|127\.0\.0\.1)/.test(h) ? "local" : h.split(".")[0].split(":")[0]; } catch { return "box"; }
}

export class Places {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  constructor(private readonly secrets: vscode.SecretStorage) {
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${SECTION}.places`)) this.changed.fire(); });
  }

  list(): Place[] {
    const raw = vscode.workspace.getConfiguration(SECTION).get<Place[]>("places") || [];
    return raw.filter((p) => p && typeof p.url === "string" && /^https?:\/\//.test(p.url)).map((p) => ({ name: String(p.name || autoName(p.url)), url: p.url.replace(/\/$/, ""), enabled: p.enabled !== false }));
  }

  async withKeys(): Promise<PlaceWithKey[]> {
    const out: PlaceWithKey[] = [];
    for (const p of this.list()) out.push({ ...p, key: (await this.secrets.get(secretKey(p.url))) || "" });
    return out;
  }

  async key(url: string): Promise<string> { return (await this.secrets.get(secretKey(url))) || ""; }

  /** Adds or updates a place. A place's key is replaced only when a non-empty one is given. */
  async add(p: PlaceWithKey): Promise<Place> {
    const url = p.url.replace(/\/$/, "");
    const list = this.list();
    const same = list.find((x) => x.url === url);
    const name = (p.name || same?.name || autoName(url)).replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "box";
    const next = same ? list.map((x) => x.url === url ? { ...x, name, enabled: p.enabled !== false } : x) : [...list, { name: uniqueName(name, list), url, enabled: p.enabled !== false }];
    if (p.key) await this.secrets.store(secretKey(url), p.key);
    await vscode.workspace.getConfiguration(SECTION).update("places", next.map(({ name, url, enabled }) => ({ name, url, enabled })), vscode.ConfigurationTarget.Global);
    return next.find((x) => x.url === url)!;
  }

  async remove(url: string): Promise<void> {
    url = url.replace(/\/$/, "");
    await vscode.workspace.getConfiguration(SECTION).update("places", this.list().filter((x) => x.url !== url), vscode.ConfigurationTarget.Global);
    await this.secrets.delete(secretKey(url));
  }

  /** The page reported its box list (a box added or renamed inside the page): merge it here, keys to secrets. The
   *  page's list can be partial (a fresh document before its places are pushed), so nothing is ever removed by it. */
  async fromPage(boxes: { name: string; url: string; key?: string; enabled?: boolean }[]): Promise<void> {
    const list = this.list();
    const next = list.slice();
    for (const b of boxes) {
      if (!/^https?:\/\//.test(b.url || "")) continue;
      const url = b.url.replace(/\/$/, "");
      if (b.key) await this.secrets.store(secretKey(url), b.key);
      const i = next.findIndex((x) => x.url === url);
      const row = { name: b.name || next[i]?.name || autoName(url), url, enabled: b.enabled !== false };
      if (i >= 0) next[i] = row; else next.push(row);
    }
    if (JSON.stringify(list) !== JSON.stringify(next)) await vscode.workspace.getConfiguration(SECTION).update("places", next, vscode.ConfigurationTarget.Global);
  }
}

function uniqueName(base: string, list: Place[]): string {
  let n = base, k = 2; while (list.some((p) => p.name === n)) n = `${base}-${k++}`; return n;
}
