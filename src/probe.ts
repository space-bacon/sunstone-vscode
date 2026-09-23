// Asks an OpenAI-compatible server what it is and what it holds. llama-server's router mode answers /models with a
// status per model; a single-model llama-server, Ollama and LM Studio answer /v1/models with a plain list.

export interface ProbedModel { id: string; status: "loaded" | "loading" | "unloaded" | "failed" | "unknown"; sizeGb?: number }
export interface Probe { up: boolean; router: boolean; models: ProbedModel[]; loaded: string; ctx?: number; kind: string; error?: string; ms: number }

async function get(url: string, key: string, timeoutMs: number): Promise<any> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function probe(base: string, key = "", timeoutMs = 4000): Promise<Probe> {
  base = base.replace(/\/$/, ""); const t0 = Date.now();
  const out: Probe = { up: false, router: false, models: [], loaded: "", kind: "", ms: 0 };
  try {
    const j = await get(`${base}/models`, key, timeoutMs).catch(() => null);
    const data: any[] = j?.data || j?.models || [];
    if (data.length && data.some((m) => m?.status?.value)) {
      out.router = true; out.kind = "llama-server router";
      out.models = data.map((m) => ({ id: String(m.id), status: m.status?.value || "unknown", sizeGb: m.meta?.size ? Math.round(m.meta.size / 1e8) / 10 : undefined }));
      out.loaded = out.models.find((m) => m.status === "loaded")?.id || "";
    } else {
      const v = await get(`${base}/v1/models`, key, timeoutMs);
      const list: any[] = v?.data || v?.models || [];
      out.models = list.map((m) => ({ id: String(m.id || m.name), status: "unknown" as const }));
      out.kind = list.some((m) => m.owned_by === "library" || m.details) ? "ollama" : list.some((m) => m.owned_by === "organization_owner") ? "lm studio" : "openai-compatible";
      // A single-model llama-server serves the one it lists; /props names it and gives the window.
      const p = await get(`${base}/props`, key, timeoutMs).catch(() => null);
      if (p) { out.kind = "llama-server"; out.ctx = p.default_generation_settings?.n_ctx; out.loaded = out.models[0]?.id || String(p.model_path || "").split("/").pop() || ""; if (out.models.length === 1) out.models[0].status = "loaded"; }
    }
    out.up = true;
  } catch (e: any) { out.error = String(e?.message || e); }
  out.ms = Date.now() - t0;
  return out;
}

// Put a model on a box: the router downloads it from Hugging Face itself (POST /models), so nothing is uploaded from
// here and no restart is needed. The id the router settles on is not the string asked for when the quant was left
// off, so the new row is found by what was not in the list before rather than by name.
export async function addModel(base: string, key: string, repo: string, report: (s: string) => void, cancelled: () => boolean): Promise<string> {
  base = base.replace(/\/$/, "");
  const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
  const list = async (reload = false): Promise<any[]> => {
    const r = await fetch(`${base}/models${reload ? "?reload=1" : ""}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`the box answered ${r.status} when asked what it holds`);
    return (await r.json() as any)?.data || [];
  };
  const before = new Set((await list()).map((m: any) => String(m.id)));
  if (before.has(repo)) throw new Error(`${repo} is already on the box`);
  const base_ = repo.split(":")[0].toLowerCase();
  const post = await fetch(`${base}/models`, { method: "POST", headers, body: JSON.stringify({ model: repo }), signal: AbortSignal.timeout(30_000) });
  if (!post.ok) throw new Error(`the box refused it (${post.status} ${(await post.text().catch(() => "")).slice(0, 200)})`);
  const t0 = Date.now();
  for (;;) {
    if (cancelled()) throw new Error("cancelled; the download continues on the box until POST /models/unload stops it");
    await new Promise((r) => setTimeout(r, 2000));
    const rows = await list();
    const fresh = rows.filter((m: any) => !before.has(String(m.id)));
    const me = fresh.find((m: any) => String(m.id).toLowerCase().startsWith(base_)) || fresh[0];
    const secs = Math.round((Date.now() - t0) / 1000);
    if (!me) {
      if (Date.now() - t0 > 600_000) throw new Error(`nothing new in the box's list after 10 minutes; check the box's log`);
      report(`asking \u00b7 ${secs} s`);
      continue;
    }
    const st = me.status?.value || "";
    if (me.status?.failed) throw new Error(`the box could not fetch ${repo}; check the box's log`);
    if (st !== "downloading") { await list(true).catch(() => []); return String(me.id); }
    const files: any[] = Object.values(me.status?.progress || {});
    const done = files.reduce((s, f) => s + (f.done || 0), 0), total = files.reduce((s, f) => s + (f.total || 0), 0);
    report(total ? `${(done / 1e9).toFixed(1)} of ${(total / 1e9).toFixed(1)} GB \u00b7 ${secs} s` : `downloading \u00b7 ${secs} s`);
  }
}
