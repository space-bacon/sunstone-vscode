import * as vscode from "vscode";
import { autoName, Places, type PlaceWithKey } from "./places";
import { Weave } from "./weave";

// "Black Window" in the chat model picker: every place in sunstone.places, every model its router lists (or the one
// model a plain llama-server serves), keyed from SecretStorage. Requests go straight to the place's
// /v1/chat/completions with tools mapped both ways, reasoning switched off the way the page does it (Qwen, Kimi and
// gpt-oss each read a different flag), and the server's own token timings kept in the Output channel.

interface BwModel extends vscode.LanguageModelChatInformation { url: string; model: string; router: boolean }

// CTX_UNSEEN is what a router model that has never been loaded is worth: the box preset drops anything over 12 GB to
// a 16K window, so assuming 32K here is how a request gets built too big to send. The real number arrives from /props
// on first use, or from the server's own 400, and is remembered per model from then on.
const CTX_DEFAULT = 32768, CTX_UNSEEN = 16384, OUT_MAX = 8192, OUT_MIN = 1024, REPLY_MIN = 256, TOOL_RESERVE = 8192, LOAD_WAIT = 900_000, FOLD_X = 4, FOLD_MAX = 131072, TOOL_SHARE = 0.4, RESULT_SHARE = 0.25, RECALL_ROUNDS = 4, REPEATS = 3, CYCLE_TAIL = 12, TAIL = 64, MARCH = 8, DRIFT = 12, ESCALATE = 3, FLAG_CHARS = 12;
const RECALL = "bw_recall";
const BRIEF = "Earlier in this conversation,";
const NUM = /-?\d+(?:\.\d+)?/g;

// One tool call with its result, as the loop detectors read it. `shape` is the arguments with every number replaced,
// so two calls that differ only in an offset share one, and `sig` does the same to the result, so a search that
// reports its own timing does not read as a different answer. `lines` is the result's substantial lines, which is
// how two differently worded searches are told from two that found different things.
type Call = { name: string; call: string; args: string; sig: string; shape: string; nums: number[]; lines: Set<string> };
// `why` is what repeats, `then` is the way out, which is not the same move for every shape: a repeated call carries
// nothing new so the turn should answer, while a walk through a file has somewhere left to go and should reach it
// another way.
type Loop = { kind: string; name: string; n: number; why: string; then: string };
const ANSWER = "Answer from what you have, or say which part you could not find and why.";

// The provider's own `contributes.languageModelChatProviders.configuration`, which replaced the deprecated
// `managementCommand`. The editor holds `apiKey` in its secret store and hands both values back on every call:
// the host passes `{silent, configuration}` into provideLanguageModelChatInformation and merges the same object
// into the response options. @types/vscode 1.137 types only `silent`, so the field is read through a cast; drop
// the cast once the typings carry it.
function configuredPlace(options: unknown): PlaceWithKey | undefined {
  const c = (options as { configuration?: Record<string, unknown> } | undefined)?.configuration;
  const url = String(c?.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) return undefined;
  return { name: autoName(url), url, key: String(c?.apiKey ?? "").trim() };
}

export class BlackWindowProvider implements vscode.LanguageModelChatProvider<BwModel> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;
  private cache: BwModel[] = [];
  private readonly windows = new Map<string, number>();
  // VS Code budgets the messages only; the tool schemas this provider adds are counted by the server and by nobody
  // else, so the last measured cost is held back from the window we advertise.
  private toolTokens = 0;
  // What has already gone into each conversation's fold, so a later turn embeds only the turns it added.
  private readonly folds = new Map<string, { chars: number; mark: string; passages: number }>();
  // Tool schemas already woven, by name and schema, so a changed set costs only the tools that changed.
  private readonly woven = new Set<string>();
  // Conversations with something folded: they get bw_recall in their tool list.
  private readonly reach = new Set<string>();
  // Replies in a row that a detector has fired on, per conversation, and zero for every other conversation. Naming
  // one tool and withholding it leaves the model the one beside it: item 13 of the 2026-09-17 run h alternated
  // blackwindow_weave_search and blackwindow_weave_folder for fifteen consecutive rounds and ended with no answer,
  // and item 5 of run i answered four searches with seven re-weaves of folders already woven, 1,332 seconds. Nine
  // of that run's twenty items reached the harness's round cap and took 96% of its 3,747 seconds. A capped item
  // scores nothing, so ending one with a wrong answer is worth more than ending it with none.
  private readonly loops = new Map<string, number>();
  // Prompt tokens a second, per model, from the server's own timings. It is what turns a proxy timeout into a
  // sentence with a number in it.
  private readonly rates = new Map<string, number>();
  // Last turn's accounting. Without it a loop case cannot tell a question VS Code dropped before the provider saw it
  // from one the model was shown and ignored.
  readonly turn = { got: 0, gotQ: false, gotTokens: 0, sent: 0, sentQ: false, note: "", stuck: "", sentTokens: 0, tools: 0, win: 0, max: 0 };
  // Which loop detectors run, by kind, and which of them withhold the tool rather than only naming what it is doing.
  // Every shape found so far was found in a transcript after the fact, so each one ships with a control arm that
  // turns its own detector off and shows the model still looping, and a second that keeps the tool and sends the
  // sentence alone. Both dials are here so those arms are two lines in the test rather than a rebuild.
  // `march` is detected and not withheld: over five replies each, the model took another page 5 times with the
  // detector off and searched 5 times under either dose, so withholding bought nothing and it is the one shape an
  // honest page-walk also trips (2026-09-16, out/test/provider.json). `drift` is the opposite and was measured the
  // same way: it searched again with the detector off and again under the sentence alone, and only stopped when the
  // tool was withheld, at which point it opened a file instead (2026-09-17).
  // `words` is not a shape but an escalation above the four of them, and it ships off. Muting every tool was meant
  // to convert a capped item into an answer; measured, it converts it into a tool call written out as prose. Three
  // items were muted across runs j and k and all three replied with a sentence of intent and a raw <tool_call>
  // block, which no parser turns back into a call and the harness scores as the answer, so all three lost the mark.
  // Declaring the schemas and sending tool_choice "none" leaks exactly as removing them does, so the cause is the
  // model continuing the pattern its own history is full of rather than the schemas being absent. Withholding one
  // tool does not do this: `swap` fired on item 7 of the two-item rerun and the reply was a clean sentence. The dial
  // stays because a model that declines to imitate its own history would measure differently.
  readonly guards = new Set(["same", "cycle", "march", "swap", "drift"]);
  readonly holds = new Set(["same", "cycle", "swap", "drift"]);

  constructor(private readonly places: Places, private readonly out: vscode.OutputChannel, private readonly weave?: Weave) {
    places.onDidChange(() => this.changed.fire());
  }

  refresh(): void { this.changed.fire(); }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<BwModel[]> {
    const list = (await this.places.withKeys()).filter((p) => p.enabled !== false);
    const configured = configuredPlace(options);
    if (configured && !list.some((p) => p.url === configured.url)) list.push(configured);
    const models: BwModel[] = [];
    await Promise.all(list.map(async (p) => {
      const headers: Record<string, string> = { "content-type": "application/json", ...(p.key ? { authorization: `Bearer ${p.key}` } : {}) };
      try {
        // A router lists its models with a status; a plain server answers /v1/models with the one it serves.
        let router = true;
        let r = await fetch(`${p.url}/models`, { headers, signal: AbortSignal.timeout(6000) }).catch(() => null);
        if (!r || !r.ok) { router = false; r = await fetch(`${p.url}/v1/models`, { headers, signal: AbortSignal.timeout(6000) }); }
        if (!r.ok) throw new Error(`${r.status}`);
        const j: any = await r.json();
        const rows: any[] = j.data || j.models || [];
        // Loaded first, then by name, so the picker's top entry is the one that answers now.
        rows.sort((a, b) => (statusOf(b) === "loaded" ? 1 : 0) - (statusOf(a) === "loaded" ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
        for (const m of rows) {
          // The router names a cached repo in full ("unsloth/GLM-4.7-Flash-GGUF:Q4_K_M") and its own preset entries
          // bare. The full name is what /models/load and /v1/chat/completions want; the last segment is only a label.
          const wire = String(m.id || m.name || "");
          const id = wire.split("/").pop() || wire;
          const status = statusOf(m);
          // /props answers for the model that is serving; asking it about the 31 others cost a 4 s timeout each (116 s to list).
          const ctx = status === "loaded" || !router ? await this.ctxOf(p.url, headers, router ? wire : "", token).catch(() => 0) : 0;
          const key = `${p.url}|${wire}`;
          if (ctx) this.windows.set(key, ctx);
          const win = this.windows.get(key) || (status === "loaded" || !router ? CTX_DEFAULT : CTX_UNSEEN);
          const out = Math.min(OUT_MAX, Math.max(OUT_MIN, Math.floor(win / 4)));
          const fits = Math.max(2048, win - out - (this.toolTokens || TOOL_RESERVE));
          // With the weave up the provider takes more history than the server holds and folds the overflow into it, so
          // the picker's percentage is against what can be accepted, not against a window that switching fills at once.
          const takes = this.weave?.up ? Math.max(fits, Math.min(FOLD_MAX, win * FOLD_X)) : fits;
          models.push({
            id: key, name: `${id} \u00b7 ${p.name}`, family: familyOf(id), version: "1",
            detail: status === "loaded" ? "serving now" : router ? "loads on first use" : undefined,
            tooltip: `${id} on ${p.name} (${hostOf(p.url)}), ${Math.round(win / 1024)}K window${this.windows.has(key) ? "" : " assumed until it loads"}${takes > fits ? `, history past it folds into the weave` : ""}${status ? `, ${status}` : ""}`,
            maxInputTokens: takes, maxOutputTokens: out,
            capabilities: { toolCalling: true, imageInput: /vl|vision|gemma-?[34]|qwen3\.5|qwen3\.8|mistral-small/i.test(id) },
            url: p.url, model: wire, router,
          });
        }
      } catch (e: any) { this.out.appendLine(`[models] ${p.name}: ${e.message || e}`); }
    }));
    this.cache = models;
    return models;
  }

  private async ctxOf(url: string, headers: Record<string, string>, model: string, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) return 0;
    const r = await fetch(`${url}/props${model ? `?model=${encodeURIComponent(model)}` : ""}`, { headers, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return 0;
    const j: any = await r.json();
    return +(j.default_generation_settings?.n_ctx || j.n_ctx || 0) || 0;
  }

  // A window we have measured replaces the assumed one, and the picker is told, so the next turn is trimmed to fit.
  private learn(model: BwModel, ctx: number): number {
    if (ctx > 0 && this.windows.get(model.id) !== ctx) {
      this.out.appendLine(`[window] ${model.name}: ${ctx} tokens${this.windows.has(model.id) ? ` (was ${this.windows.get(model.id)})` : ""}`);
      this.windows.set(model.id, ctx); this.changed.fire();
    }
    return this.windows.get(model.id) || CTX_UNSEEN;
  }

  // Before the first request to a router model, put it on the GPU and ask what window it got. Letting the router load
  // on first use works, but the window stays a guess until something has loaded, which is how a request gets refused.
  private async ready(model: BwModel, key: string, token: vscode.CancellationToken): Promise<number> {
    if (this.windows.has(model.id)) return this.windows.get(model.id)!;
    const headers: Record<string, string> = { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) };
    if (!model.router) return this.learn(model, await this.ctxOf(model.url, headers, "", token).catch(() => 0));
    const statusNow = async (): Promise<string> => {
      const r = await fetch(`${model.url}/models`, { headers, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`${model.name}: the router answered ${r.status} when asked what it holds`);
      const rows: any[] = ((await r.json()) as any).data || [];
      const me = rows.find((m: any) => (String(m.id || "").split("/").pop() || m.id) === model.model);
      if (!me) throw new Error(`${model.name}: ${model.model} is no longer in the router's list; refresh Sunstone's places and pick again`);
      return statusOf(me);
    };
    let st = await statusNow();
    if (st !== "loaded") {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `${model.model} loading on ${hostOf(model.url)}`, cancellable: true }, async (progress, ct) => {
        if (st !== "loading") {
          const r = await fetch(`${model.url}/models/load`, { method: "POST", headers, body: JSON.stringify({ model: model.model }), signal: AbortSignal.timeout(30_000) });
          if (!r.ok) throw new Error(`${model.name}: the router refused to load it (${r.status} ${(await r.text().catch(() => "")).slice(0, 160)})`);
        }
        const t0 = Date.now();
        for (;;) {
          if (ct.isCancellationRequested || token.isCancellationRequested) throw new Error(`${model.name}: cancelled while loading`);
          await new Promise((res) => setTimeout(res, 2000));
          st = await statusNow();
          progress.report({ message: `${st || "asked"} \u00b7 ${Math.round((Date.now() - t0) / 1000)} s` });
          if (st === "loaded") return;
          if (st === "failed") throw new Error(`${model.name}: the router failed to load it; see the server's log on ${hostOf(model.url)}`);
          if (Date.now() - t0 > LOAD_WAIT) throw new Error(`${model.name}: still ${st || "unloaded"} after ${Math.round(LOAD_WAIT / 60_000)} minutes`);
        }
      });
    }
    return this.learn(model, await this.ctxOf(model.url, headers, model.model, token).catch(() => 0));
  }

  // The server counts the tool schemas; VS Code's budget does not. A refusal names both numbers and what to change.
  private failed(model: BwModel, status: number, text: string, prompt = 0): Error {
    let j: any = null; try { j = JSON.parse(text); } catch {}
    const e = j?.error || {};
    if (e.type === "exceed_context_size_error" || /exceeds the available context size/.test(text)) {
      const ctx = +e.n_ctx || 0, used = +e.n_prompt_tokens || 0;
      if (ctx) this.learn(model, ctx);
      const here = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]?/i.test(model.url);
      const fix = here
        ? "raise sunstone.local.ctx, then run Sunstone: Stop llama-server and Sunstone: Start llama-server on This Machine"
        : `raise c for [${model.model}] in models.ini on ${hostOf(model.url)} and restart llama-server there`;
      return new Error(`${model.name}: the request was ${used || "?"} tokens against a ${ctx || "?"} token window${this.toolTokens ? `, about ${this.toolTokens} of it the tool schemas` : ""}. The real window is now in the model picker, so sending again will trim the history to fit. To keep the history instead, ${fix}.`);
    }
    // A proxy's own error page rather than the server's answer. 524 is a Cloudflare tunnel giving up after waiting
    // 100 seconds for a first byte, which a large prompt on a loaded box passes routinely; the HTML says none of
    // that, and it is what one 36 minute run ended on (2026-09-17).
    if ((status >= 520 && status <= 527) || /^\s*<(!doctype|html)/i.test(text)) {
      const rate = this.rates.get(model.model) || 0;
      const wait = rate && prompt ? ` Prompt processing here last measured ${Math.round(rate)} tokens a second, so a ${prompt} token prompt needs about ${Math.round(prompt / rate)} seconds before the first byte.` : "";
      return new Error(`${model.name}: the proxy in front of ${hostOf(model.url)} answered ${status} with its own error page, so the request never reached an answer from the box.${wait} A Cloudflare tunnel waits 100 seconds. Send a shorter history, or reach the box directly.`);
    }
    return new Error(`${model.name}: server ${status} ${text.slice(0, 200)}`);
  }

  // 88 tool schemas measured 37,934 tokens, over twice a 16K window, so trimming history cannot help: the tools
  // themselves have to be chosen. Each is woven under its own source and the turn's question picks the ones that fit.
  private async pickTools(body: any, all: any[], ask: string, budget: number, id: string, offerRecall: boolean): Promise<string> {
    const reach = offerRecall && this.reach.has(id) ? [recallTool()] : [];
    // A turn that brings no tools of its own still needs the reach, and that is exactly the turn that has it worst:
    // ask mode after a long read, where the fold is the only copy of what was cut.
    if (!all.length) {
      if (!reach.length) { delete body.tools; return ""; }
      body.tools = reach; body.tool_choice = "auto"; return `${RECALL} only`;
    }
    const cost = new Map<any, number>(all.map((t) => [t, estimate(t)]));
    const spare = budget - reach.reduce((a, t) => a + estimate(t), 0);
    if (all.reduce((a, t) => a + cost.get(t)!, 0) <= spare) { body.tools = [...all, ...reach]; return ""; }
    const byName = new Map<string, any>(all.map((t) => [t.function.name, t]));
    const order: any[] = [];
    const take = (t: any) => { if (t && !order.includes(t)) order.push(t); };
    // A tool the recent history called stays, or the model sees a call it has no schema for. Only the recent turns,
    // since a long agent run has called more distinct tools than the budget holds.
    for (const m of body.messages.slice(-12)) for (const c of m.tool_calls || []) take(byName.get(c.function?.name));
    let how = "declaration order";
    if (this.weave?.up && ask.trim()) {
      try {
        for (const t of all) {
          const mark = `${t.function.name}:${hash(JSON.stringify(t))}`;
          if (this.woven.has(mark)) continue;
          await this.weave.fold(`tool:${t.function.name}`, describe(t));
          this.woven.add(mark);
        }
        for (const h of await this.weave.recall("tool:", ask, all.length)) take(byName.get(h.source.slice(5)));
        how = "the weave";
      } catch (e: any) { this.out.appendLine(`[tools] ${e.message || e}`); }
    }
    for (const t of all) take(t);
    const keep: any[] = []; let used = 0;
    for (const t of order) { const c = cost.get(t)!; if (used + c > spare) continue; keep.push(t); used += c; }
    body.tools = [...keep, ...reach];
    return `${keep.length} of ${all.length} tools by ${how}`;
  }

  // A single file read can be larger than the whole window. The head stays in the prompt and the rest joins this
  // conversation's fold, where bw_recall can reach it.
  private async shrink(msgs: any[], id: string, budget: number): Promise<string> {
    const cap = Math.max(1200, budget * 3);
    let cut = 0, chars = 0;
    for (const m of msgs) {
      if (m.role !== "tool" || typeof m.content !== "string" || m.content.length <= cap) continue;
      const rest = m.content.slice(cap);
      if (this.weave?.up) {
        const src = `chat:${id}/r${hash(String(m.tool_call_id || cut))}`;
        if (!this.folds.has(src)) { await this.weave.fold(src, m.content); this.folds.set(src, { chars: m.content.length, mark: hash(m.content), passages: 1 }); }
        this.reach.add(id);
      }
      m.content = `${m.content.slice(0, cap)}\n\n[${Math.round(rest.length / 1000)}K more characters of this result are in the weave; call ${RECALL} to search them]`;
      cut++; chars += rest.length;
    }
    return cut ? `${cut} result${cut === 1 ? "" : "s"} shortened, ${Math.round(chars / 1000)}K folded` : "";
  }

  // A 200K model's history arrives whole at a 16K one, because VS Code trims to maxInputTokens without counting the
  // tool schemas the server counts. The turns that do not fit go into the weave under this conversation's own source
  // and come back as the passages nearest the question, so what is dropped is the least relevant part, not the oldest.
  private async fit(body: any, id: string, win: number, out: number, tools: number): Promise<string> {
    const msgs: any[] = body.messages;
    const budget = win - out - 256;
    const cost = (m: any[]) => estimate(m) + tools;
    if (msgs.length < 3 || cost(msgs) <= budget) return "";
    // The first message carries the instructions and the last is the turn being asked, so both stay; the window in
    // between goes to the newest turns, and a tool result whose call was folded away is folded with it.
    // The question is pinned as well. In an agent loop the last message is a tool result, not the user turn, so
    // without this the task itself is what gets dropped: the model is left holding its own last call and its result
    // and repeats the call, which is a fixed point it cannot leave (measured 2026-09-16, a 16K window loops from
    // round 18). It is also what left `last` undefined below, so nothing was recalled either.
    const pin = new Set<number>([0, msgs.length - 1]);
    const q = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i > 0).pop();
    if (q !== undefined) pin.add(q);
    const held = (c: number) => msgs.filter((_, i) => pin.has(i) || i >= c - 1);
    let cut = msgs.length - 1;
    while (cut > 1 && cost(held(cut)) <= budget) cut--;
    // Tested one message wider than it is kept, so what survives is the last set known to fit rather than the first
    // one that did not.
    const keep = msgs.filter((_, i) => pin.has(i) || i >= cut), dropped = msgs.filter((m) => !keep.includes(m));
    msgs.length = 0; msgs.push(...keep);
    const ids = new Set<string>();
    for (const m of msgs) for (const c of m.tool_calls || []) ids.add(c.id);
    for (let i = msgs.length - 1; i >= 1; i--) if (msgs[i].role === "tool" && !ids.has(msgs[i].tool_call_id)) dropped.push(...msgs.splice(i, 1));
    if (!dropped.length) return "";
    const why = `${dropped.length} turn${dropped.length === 1 ? "" : "s"} dropped`;
    if (!this.weave?.up) return `${why}, weave down`;
    const last = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0).pop();
    if (last === undefined) return `${why}, no user turn to carry them`;
    try {
      const full = dropped.map(transcribe).filter(Boolean).join("\n\n");
      const src = `chat:${id}/turns`;
      const was = this.folds.get(src);
      const grew = !!was && full.length > was.chars && hash(full.slice(0, was.chars)) === was.mark;
      const n = grew ? was!.passages + await this.weave.fold(src, full.slice(was!.chars), false) : await this.weave.fold(src, full, true);
      this.folds.set(src, { chars: full.length, mark: hash(full), passages: n });
      this.reach.add(id);
      const room = budget - cost(msgs) - 64;
      if (n <= 0 || room < 256) return `${why}, ${n <= 0 ? "nothing folded" : "no room to recall"}`;
      if (text(msgs[last]).startsWith(BRIEF)) return `${why}, ${n} passages folded`;
      const hits = await this.weave.recall(`chat:${id}/`, text(msgs[last]).slice(0, 2000), 8);
      const keep: string[] = [];
      let used = 0;
      for (const h of hits) {
        const line = `[${keep.length + 1}] ${h.text.slice(0, 1200)}`;
        const c = estimate(line); if (used + c > room) break;
        keep.push(line); used += c;
      }
      if (!keep.length) return `${why}, ${n} passages folded, none fit`;
      // With the question rather than at the head, so the constant prefix stays byte-identical for the prompt cache.
      const brief = `${BRIEF} the passages nearest this question (${dropped.length} turns were folded into the weave to fit this model's window; call ${RECALL} for anything else you need from it):\n\n${keep.join("\n\n")}\n\n---\n\n`;
      if (typeof msgs[last].content === "string") msgs[last].content = brief + msgs[last].content;
      else (msgs[last].content as any[]).unshift({ type: "text", text: brief });
      return `${why}, ${n} passages folded, ${keep.length} recalled`;
    } catch (e: any) {
      this.out.appendLine(`[fold] ${e.message || e}`);
      return `${why}, weave failed`;
    }
  }

  // The last TAIL tool calls with their results, newest first, which is the one view every detector reads. How far
  // back each of them looks is its own business: a run counted from the newest call cannot gain a false hit from a
  // longer window, only a truer count, while a detector counting revisits gains one and keeps a short window.
  private tail(msgs: any[]): Call[] {
    const tail: Call[] = [];
    for (let i = msgs.length - 2; i >= 0 && tail.length < TAIL; i--) {
      const a = msgs[i], t = msgs[i + 1];
      if (a?.role !== "assistant" || t?.role !== "tool") continue;
      const c = (a.tool_calls || []).find((x: any) => x.id === t.tool_call_id) ?? (a.tool_calls || [])[0];
      const name = c?.function?.name;
      if (!name) continue;
      const args = String(c.function.arguments ?? "");
      const call = `${name}\u0000${args}`;
      const body: string = typeof t.content === "string" ? t.content : JSON.stringify(t.content ?? "");
      tail.push({
        name, call, args, sig: `${call}\u0000${body.replace(NUM, "#")}`,
        shape: `${name}\u0000${args.replace(NUM, "#")}`, nums: (args.match(NUM) || []).map(Number),
        lines: new Set(body.split("\n").map((l) => l.trim()).filter((l) => l.length > 40)),
      });
    }
    return tail;
  }

  // The first shape that fires and whose detector is switched on. A detector turned off for a control arm does not
  // mask the others, so an arm measures one guard rather than the set.
  private stuck(msgs: any[]): Loop | undefined {
    const tail = this.tail(msgs);
    if (!tail.length) return undefined;
    for (const find of DETECTORS) { const hit = find(tail); if (hit && this.guards.has(hit.kind)) return hit; }
    return undefined;
  }

  // Only the tool that is going nowhere is withheld, so the turn can still act, it just cannot make the call it has
  // already made. Where it was the only tool, the turn has to produce words instead. Once `mute` is set the caller
  // has taken every tool away, and what the reply is told is different: the way out is not another call.
  private unstick(body: any, loop: Loop, runs: number, mute: boolean): string {
    const hold = !mute && this.holds.has(loop.kind);
    if (hold) {
      const kept = (body.tools || []).filter((t: any) => t.function?.name !== loop.name);
      if (kept.length) body.tools = kept; else { delete body.tools; delete body.tool_choice; }
    }
    // At the tail, where fit() pins it and the cached prefix is left byte-identical.
    const say = mute
      ? `\n\n[${runs} replies in a row here have gone in a circle, the last of them calling ${loop.name} ${loop.n} times ${loop.why}. No tool can be called on this reply, and writing a call out as text is not a way round that. Everything the calls above returned is still in this conversation. ${ANSWER}]`
      : `\n\n[${loop.name} has been called ${loop.n} times here ${loop.why}. Repeating it is not moving this forward, so it is ${hold ? "withheld for this reply" : "unlikely to help"}. ${loop.then}]`;
    const last = body.messages[body.messages.length - 1];
    if (typeof last.content === "string") last.content += say;
    else if (Array.isArray(last.content)) last.content.push({ type: "text", text: say });
    else last.content = say;
    this.turn.stuck = `${loop.name} x${loop.n} ${loop.kind}${mute ? " all withheld" : hold ? "" : " said"}`;
    return mute ? `every tool withheld after ${runs} replies in a row in a loop` : `${loop.name} ${hold ? "withheld" : "named"} after ${loop.n} calls ${loop.why}`;
  }

  async provideLanguageModelChatResponse(model: BwModel, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
    // A place added through the command has its key in our secret store; one typed into the provider's own
    // configuration has it in the editor's, and arrives on the request instead.
    const key = (await this.places.key(model.url)) || configuredPlace(options)?.key || "";
    const body: any = {
      model: model.model, stream: true, stream_options: { include_usage: true }, timings_per_token: true,
      messages: toOpenAI(messages),
      temperature: options.modelOptions?.temperature ?? 0.3,
      chat_template_kwargs: { enable_thinking: false, thinking: false, reasoning_effort: "low" },
    };
    const all: any[] = (options.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: "object", properties: {} } } }));
    Object.assign(this.turn, { got: body.messages.length, gotQ: body.messages.some((m: any, i: number) => i > 0 && m.role === "user"), gotTokens: estimate(body.messages), sent: 0, sentQ: false, note: "", stuck: "" });
    if (all.length) body.tool_choice = options.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto";
    // Ask what window the model actually got, loading it first if the router has not, then make the prompt fit it.
    const win = await this.ready(model, key, token);
    const out = Math.min(OUT_MAX, Math.max(OUT_MIN, Math.floor(win / 4)));
    const want = Math.min(OUT_MAX, options.modelOptions?.max_tokens ?? OUT_MAX);
    const id = hash(text(body.messages[0]) + text(body.messages[1]));
    const ctl = new AbortController();
    const sub = token.onCancellationRequested(() => ctl.abort());
    const t0 = Date.now();
    try {
      // A single file read can be larger than the whole window, so a long result keeps its head and the rest joins the
      // fold. The model gets bw_recall to reach any of it, which is what makes the window stop being the limit.
      const notes = [await this.shrink(body.messages, id, Math.floor((win - out) * RESULT_SHARE))];
      const loop = this.stuck(body.messages);
      // Consecutive, so an ordinary turn that loops once and recovers starts again from nothing.
      const runs = loop ? (this.loops.get(id) ?? 0) + 1 : 0;
      if (loop) this.loops.set(id, runs); else this.loops.delete(id);
      const mute = !!loop && runs >= ESCALATE && this.guards.has("words");
      for (let round = 0; ; round++) {
        // On the last round bw_recall is withheld, or a model that answers every turn by reaching for more would
        // spend the whole loop recalling and return nothing, which is how a conversation summary fails.
        const done = round >= RECALL_ROUNDS;
        const ask = [...body.messages].reverse().find((m: any) => m.role === "user");
        const picked = await this.pickTools(body, all, text(ask).slice(0, 2000), Math.floor((win - out) * TOOL_SHARE), id, !done);
        // Muted by forbidding the choice, with the schemas left declared. Removing them while the history is full of
        // tool calls left the model imitating the syntax in prose: both items run j muted answered with a sentence
        // and a raw <tool_call> block, which no parser turns back into a call and the harness scored as the answer.
        if (mute && body.tools) body.tool_choice = "none";
        if (loop && round === 0) notes.push(this.unstick(body, loop, runs, mute));
        const toolTokens = body.tools ? estimate(body.tools) : 0;
        if (toolTokens + OUT_MIN + 512 > win) {
          this.changed.fire();
          throw new Error(`${model.name}: the ${body.tools?.length ?? 0} tool schemas kept are about ${toolTokens} tokens and ${model.model} is serving a ${win} token window, so no prompt can fit. Give it a bigger window, or turn tools off for this model.`);
        }
        const fitted = await this.fit(body, id, win, out, toolTokens);
        if (round === 0) notes.push(picked, fitted); else if (fitted) notes.push(fitted);
        // fit() pins the instructions, the question and the last turn, so one oversized pinned message can still
        // leave the prompt over the window. Asking for OUT_MIN anyway overflows it and the server answers with
        // nothing, which the round below then reports as the model returning nothing. Take the room that is left,
        // and where there is none say so with the numbers rather than blaming the model for an empty reply.
        const room = win - estimate(body.messages) - toolTokens - 256;
        Object.assign(this.turn, {
          sent: body.messages.length, sentQ: body.messages.some((m: any, i: number) => i > 0 && m.role === "user"),
          note: notes.filter(Boolean).join(" \u00b7 "), sentTokens: estimate(body.messages), tools: toolTokens, win, max: Math.min(want, Math.max(0, room)),
        });
        if (room < REPLY_MIN) {
          this.changed.fire();
          throw new Error(`${model.name}: the prompt is about ${estimate(body.messages) + toolTokens} tokens against a ${win} token window, ${toolTokens} of it ${body.tools?.length ?? 0} tool schemas, so there is no room to reply. Start a new chat, or give this model a bigger window.`);
        }
        body.max_tokens = Math.min(want, room);
        const r = await this.stream(model, key, body, progress, ctl);
        if (r.timings?.prompt_per_second) this.rates.set(model.model, r.timings.prompt_per_second);
        // Half a call is not a call: running it would act on a truncated path. Raising it here is what keeps our own
        // cut-off reply from arriving at the model as a tool error it spends the next half hour working around.
        if (r.partial.length) {
          this.changed.fire();
          throw new Error(`${model.name}: the reply was cut off part-way through a call to ${r.partial.join(" and ")}, so its arguments are incomplete and running it would act on a truncated path. ${r.finish === "length" ? `The reply reached its ${body.max_tokens} token cap, against a ${win} token window already holding about ${estimate(body.messages) + toolTokens} tokens. Start a new chat, or give this model a bigger window.` : `The connection closed before the reply finished, which is what a proxy in front of the box does when the box takes longer than the proxy waits.`}`);
        }
        const back = [...r.calls.values()].filter((c) => c.name === RECALL);
        const real = [...r.calls.values()].filter((c) => c.name !== RECALL);
        if (back.length && !real.length && !done) {
          body.messages.push({ role: "assistant", content: "", tool_calls: back.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })) });
          for (const c of back) body.messages.push({ role: "tool", tool_call_id: c.id, content: await this.reached(id, c.args, Math.floor((win - out) * RESULT_SHARE)) });
          notes.push(`recalled ${back.length}`);
          continue;
        }
        if (back.length) this.out.appendLine(`[recall] ${model.name}: ${back.length} dropped, the turn also called ${real.map((c) => c.name).join(", ") || "nothing"}`);
        for (const c of real) {
          progress.report(new vscode.LanguageModelToolCallPart(c.id, c.name, c.args ? JSON.parse(c.args) : {}));
        }
        const secs = (Date.now() - t0) / 1000;
        const note = notes.filter(Boolean).join(" \u00b7 ");
        this.out.appendLine(`[chat] ${model.name}: first token ${r.first ? ((r.first - t0) / 1000).toFixed(2) : "-"} s \u00b7 ${r.timings?.predicted_per_second ? Math.round(r.timings.predicted_per_second) + " tok/s" : "-"} \u00b7 ${r.usage?.prompt_tokens ?? r.timings?.prompt_n ?? "-"} in${r.timings?.cache_n ? ` (${r.timings.cache_n} cached)` : ""} / ${r.usage?.completion_tokens ?? r.timings?.predicted_n ?? "-"} out of ${win} \u00b7 ${note ? note + " \u00b7 " : ""}${real.length ? `${real.length} tool call${real.length > 1 ? "s" : ""} \u00b7 ` : ""}${secs.toFixed(1)} s`);
        // Nothing streamed and nothing called is a failed turn, and returning quietly leaves the caller to guess.
        // The numbers go in the message so this is separable from the prompt having had no room in the first place.
        if (!r.text && !real.length) throw new Error(`${model.name}: the model returned no text and no tool call after ${round + 1} round${round ? "s" : ""}${back.length ? `, spending them on ${RECALL}` : ""}. The prompt was about ${estimate(body.messages) + toolTokens} tokens of a ${win} token window with ${body.max_tokens} left to reply, so the room was there.`);
        // The server's own count is the only exact one: keep the tool share honest from the difference it reveals.
        const counted = +(r.usage?.prompt_tokens ?? r.timings?.prompt_n ?? 0);
        if (counted > 0 && body.tools?.length) this.toolTokens = Math.max(0, counted - estimate(body.messages));
        return;
      }
    } finally { sub.dispose(); }
  }

  private async stream(model: BwModel, key: string, body: any, progress: vscode.Progress<vscode.LanguageModelResponsePart>, ctl: AbortController) {
    const r = await fetch(`${model.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok || !r.body) throw this.failed(model, r.status, await r.text().catch(() => ""), estimate(body.messages) + (body.tools ? estimate(body.tools) : 0));
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = "";
    // Tool calls stream as fragments keyed by index; each is emitted once its arguments parse (at the end).
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let timings: any = null, usage: any = null, first = 0, text = 0, finish = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim(); if (!data || data === "[DONE]") continue;
        let j: any; try { j = JSON.parse(data); } catch { continue; }
        if (j.usage) usage = j.usage; if (j.timings) timings = j.timings;
        const ch = j.choices?.[0]; if (!ch) continue;
        if (ch.finish_reason) finish = ch.finish_reason;
        const d = ch.delta; if (!d) continue;
        if (d.content) { if (!first) first = Date.now(); text += d.content.length; progress.report(new vscode.LanguageModelTextPart(d.content)); }
        for (const tc of d.tool_calls || []) {
          const k = tc.index ?? 0; const cur = calls.get(k) || { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id; if (tc.function?.name) cur.name += tc.function.name; if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(k, cur);
        }
      }
    }
    // A reply cut off part-way through a call leaves its arguments as unterminated JSON. Wrapping that as {_raw} and
    // reporting it turns our truncation into a tool error the model then works around: four of the last six turns of
    // a 36 minute run went that way (2026-09-17). Such a call is held back here and named by the caller instead.
    const partial: string[] = [];
    for (const [k, c] of [...calls]) {
      if (!c.id) c.id = `call_${Math.random().toString(36).slice(2, 10)}`;
      if (!c.args) continue;
      try { JSON.parse(c.args); } catch { partial.push(c.name || "an unnamed tool"); calls.delete(k); }
    }
    return { calls, timings, usage, first, text, finish, partial };
  }

  // Everything folded out of this conversation, searched on the model's own request. This is the reach that makes the
  // server's window a working set rather than a ceiling.
  private async reached(id: string, args: string, cap: number): Promise<string> {
    let q = ""; try { q = String(JSON.parse(args || "{}").query || ""); } catch { q = args; }
    if (!q.trim()) return "bw_recall needs a query.";
    if (!this.weave?.up) return "The weave is not up, so nothing folded can be reached.";
    const hits = await this.weave.recall(`chat:${id}/`, q.slice(0, 2000), 12);
    if (!hits.length) return `Nothing folded out of this conversation matches "${q}".`;
    const lines: string[] = []; let used = 0;
    for (const h of hits) {
      const line = `[${lines.length + 1}] ${h.text.slice(0, 1600)}`;
      const c = estimate(line); if (used + c > cap) break;
      lines.push(line); used += c;
    }
    return lines.join("\n\n");
  }

  async provideTokenCount(_model: BwModel, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    const s = typeof text === "string" ? text : text.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : p instanceof vscode.LanguageModelToolResultPart ? JSON.stringify(p.content) : p instanceof vscode.LanguageModelToolCallPart ? JSON.stringify(p.input) : "")).join("");
    return estimate(s);
  }
}

// A call that returns what the same call already returned carries nothing new, and a model that keeps reissuing it is
// in a fixed point it does not leave on its own: 26 identical queries in one conversation, 6 in 18 seconds in a
// second, and 38 back to back in a third (2026-09-16, GLM-4.7-Flash, all three ending with no answer at all).
// Arguments repeating back to back is the trigger that holds, because a terminal command's output carries a prompt
// line and a shell's noise, so two runs of one command are rarely byte-identical and result equality misses it.
// Adjacency is what keeps it off an edit-then-rerun cycle, where the edit sits between the two runs.
function repeated(tail: Call[]): Loop | undefined {
  let n = 0;
  while (n < tail.length && tail[n].call === tail[0].call) n++;
  return n >= REPEATS ? { kind: "same", name: tail[0].name, n, why: "with the same arguments", then: ANSWER } : undefined;
}

// Same call and the same answer but not adjacent, which is how a model alternating between two of them looks, and
// how one assessment run issued a single weave query four times with reads in between (2026-09-16). The answer is
// compared with its numbers stripped: three identical searches reporting three different durations are one answer,
// while a test suite going from two failures to one is two, and reissuing that is the move that fixes it. The only
// detector with a short window, because three revisits over a long enough history is how ordinary work looks.
function cycling(tail: Call[]): Loop | undefined {
  const seen = new Map<string, { name: string; n: number }>();
  for (const p of tail.slice(0, CYCLE_TAIL)) { const hit = seen.get(p.sig) ?? { name: p.name, n: 0 }; hit.n++; seen.set(p.sig, hit); }
  let worst: Loop | undefined;
  for (const hit of seen.values()) if (hit.n >= REPEATS && (!worst || hit.n > worst.n)) worst = { kind: "cycle", ...hit, why: "with the same arguments and the same result", then: ANSWER };
  return worst;
}

// Same tool and same arguments but for numbers that only advance: a model walking one file in fixed steps instead of
// searching it. 171 of 184 file reads in one assessment run stepped through a single JSON 20 lines at a time over 174
// distinct offsets and the run ended with no answer (2026-09-16, GLM-4.7-Flash). Neither detector above can see it,
// because no two of those calls are alike. MARCH is 8 rather than REPEATS because a few pages of one file is how
// reading works; eight consecutive steps and nothing else is how not finding something works.
function marching(tail: Call[]): Loop | undefined {
  let n = 0;
  while (n < tail.length && tail[n].shape === tail[0].shape) n++;
  if (n < MARCH || !tail[0].nums.length) return undefined;
  // Newest first, so a walk forward reads as a descent here. Either direction is a walk; offsets that jump about are
  // not, because reading a file at unrelated places is searching it.
  for (let c = 0; c < tail[0].nums.length; c++) {
    let up = true, down = true;
    for (let i = 1; i < n; i++) { const a = tail[i - 1].nums[c], b = tail[i].nums[c]; if (a <= b) up = false; if (a >= b) down = false; }
    if (up || down) return {
      kind: "march", name: tail[0].name, n,
      why: `with only the numbers in its arguments moving, ${tail[n - 1].nums[c]} to ${tail[0].nums[c]} a step at a time`,
      then: `Step ${n + 1} will read as little as the last ${n} did. Reach the rest another way, by searching it for what you are looking for, or ${ANSWER[0].toLowerCase()}${ANSWER.slice(1)}`,
    };
  }
  return undefined;
}

// Loop shapes, least evidence first, each reading the same newest-first tail and naming itself. A shape found in a
// later transcript is a function here, a kind in `guards`, and a test arm; it is not another branch inside one
// growing condition, which is what the first two shapes had become.
const DETECTORS: ((tail: Call[]) => Loop | undefined)[] = [repeated, cycling, marching, swapping, drifting];

// Two argument objects that agree on everything but one short value: "" when they are identical, the differing key
// when exactly one differs and both its values are short, null otherwise. Two keys are wanted, so a tool taking one
// path or one command is never read as a flag being turned; listing three directories in a row is work.
function flag(a: string, b: string): string | null {
  if (a === b) return "";
  let x: any, y: any;
  try { x = JSON.parse(a); y = JSON.parse(b); } catch { return null; }
  if (!x || !y || typeof x !== "object" || typeof y !== "object" || Object.keys(x).length < 2) return null;
  let differ = "";
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (JSON.stringify(x[k]) === JSON.stringify(y[k])) continue;
    if (differ) return null;
    differ = k;
  }
  return String(x[differ] ?? "").length <= FLAG_CHARS && String(y[differ] ?? "").length <= FLAG_CHARS ? differ : null;
}

// The same call but for a flag. Item 7 of the 2026-09-17 run i made one search five times over with `kind` rotating
// through code, all, text, code, all, and item 12 made another four times the same way; both ran to the round cap
// with no answer. Neither detector above reaches it: `repeated` compares the arguments literally, so a rotating flag
// is five different calls, and `cycling` compares the result, which the flag does change. Since the morning of that
// day `kind` is a bonus rather than a partition, so rotating it moves the list least of all the arguments. Adjacent,
// like `repeated`, and it leaves the all-identical run to `repeated`, which runs first and says the plainer thing.
function swapping(tail: Call[]): Loop | undefined {
  let n = 1, key = "";
  while (n < tail.length && tail[n].name === tail[0].name) {
    const k = flag(tail[n].args, tail[0].args); if (k === null) break;
    if (k) key = k; n++;
  }
  if (n < REPEATS || !key) return undefined;
  return {
    kind: "swap", name: tail[0].name, n,
    why: `with the same arguments but for ${key}`,
    then: `Turning ${key} over is returning the same material. Ask a different question, reach it another way, or ${ANSWER[0].toLowerCase()}${ANSWER.slice(1)}`,
  };
}

// One tool used and nothing else, for long enough that the words have stopped mattering. Thirteen of twenty items in
// the 2026-09-17 assessment ended this way, running to the harness's fourteen-round cap with no answer: item 11 made
// fourteen searches, item 6 made fourteen, item 7 re-wove one folder seven times. The first version of this keyed on
// the results overlapping and never fired once against a real store, because a reworded query returns different
// passages; the queries drift progressively, so "mean vector restored retrieval 0.195" and "recall@1 deployed
// figures" share no words at all. Length is the signal that survives. DRIFT is 12 because the failing runs were 12
// to 14, four searches that find the answer on the fourth are how searching well looks, and a page-walk of ten pages
// belongs to `marching`, which runs first and holds nothing.
function drifting(tail: Call[]): Loop | undefined {
  let n = 0;
  while (n < tail.length && tail[n].name === tail[0].name) n++;
  if (n < DRIFT) return undefined;
  // `repeated` owns the case where the words never changed either.
  if (tail.slice(0, n).every((c) => c.call === tail[0].call)) return undefined;
  return {
    kind: "drift", name: tail[0].name, n,
    why: `${n} times in a row with nothing else tried`,
    then: "Another call to it will not be the one that works. Open the file that would hold the answer, run a check, or say which part you could not find and why.",
  };
}


const estimate = (v: any): number => Math.ceil((typeof v === "string" ? v : JSON.stringify(v ?? "")).length / 3.2);
// One OpenAI message as prose, so the weave indexes turns and tool results the way it indexes anything else.
const text = (m: any): string => (typeof m?.content === "string" ? m.content : (m?.content || []).map((c: any) => c?.text || "").join("\n"));
const transcribe = (m: any): string => {
  const calls = (m.tool_calls || []).map((c: any) => `${c.function?.name}(${String(c.function?.arguments || "").slice(0, 600)})`).join("\n");
  const body = [text(m), calls].filter(Boolean).join("\n").trim();
  return body ? `${m.role === "tool" ? "tool result" : m.role}: ${body}` : "";
};
// A tool as the weave indexes it: what it is for, in the words a question about it would use.
const describe = (t: any): string => {
  const f = t.function || {};
  const props = Object.keys(f.parameters?.properties || {});
  return `${f.name}: ${f.description || ""}${props.length ? `\nparameters: ${props.join(", ")}` : ""}`;
};
// The model's way back into what was folded: the window becomes a working set instead of a ceiling.
const recallTool = () => ({ type: "function", function: { name: RECALL, description: "Search everything folded out of this conversation to fit the model's window: earlier turns, and the parts of long tool results that were cut. Call it whenever the context refers to something you cannot see.", parameters: { type: "object", properties: { query: { type: "string", description: "What to look for, in plain words" } }, required: ["query"] } } });
// FNV-1a over the first message: the same conversation folds into the same source on every turn.
const hash = (s: string): string => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const statusOf = (m: any) => typeof m.status === "string" ? m.status : m.status?.value || "";
const hostOf = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const familyOf = (id: string) => (id.match(/^[A-Za-z]+(?:-?\d+(?:\.\d+)?)?/) || [id])[0].toLowerCase();

// VS Code's message parts to the OpenAI shape llama-server reads: text and tool calls on assistant turns, tool
// results as role "tool" messages, images as data URLs.
function toOpenAI(messages: readonly vscode.LanguageModelChatRequestMessage[]): any[] {
  const out: any[] = [];
  for (const m of messages) {
    const role = m.role === vscode.LanguageModelChatMessageRole.Assistant ? "assistant" : "user";
    const texts: string[] = []; const images: any[] = []; const calls: any[] = []; const results: any[] = [];
    for (const p of m.content) {
      if (p instanceof vscode.LanguageModelTextPart) texts.push(p.value);
      else if (p instanceof vscode.LanguageModelToolCallPart) calls.push({ id: p.callId, type: "function", function: { name: p.name, arguments: JSON.stringify(p.input ?? {}) } });
      else if (p instanceof vscode.LanguageModelToolResultPart) results.push({ role: "tool", tool_call_id: p.callId, content: p.content.map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : typeof c === "string" ? c : JSON.stringify(c))).join("\n") });
      else if (p instanceof vscode.LanguageModelDataPart && /^image\//.test(p.mimeType)) images.push({ type: "image_url", image_url: { url: `data:${p.mimeType};base64,${Buffer.from(p.data).toString("base64")}` } });
    }
    if (role === "assistant") { const msg: any = { role, content: texts.join("\n") }; if (calls.length) msg.tool_calls = calls; if (texts.length || calls.length) out.push(msg); }
    else if (results.length) out.push(...results);
    else if (images.length) out.push({ role, content: [...texts.map((t) => ({ type: "text", text: t })), ...images] });
    else if (texts.length) out.push({ role, content: texts.join("\n") });
  }
  return out;
}
