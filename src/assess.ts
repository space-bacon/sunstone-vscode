import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

// The assessment loop, shared by the unattended harness in test/assess.ts and the `Sunstone: Run the assessment`
// command. One implementation, because the day the scoring logic lived in two places it produced two answers.
//
// The command runs it in the editor the user is already working in, which is the surface a person actually uses:
// Copilot is signed in there, consent persists, and every model in the picker is selectable. The test host cannot
// have any of that, running with in-memory storage. The cost is that the store is the editor's own rather than an
// isolated one, so a score from this surface is not comparable to one from the harness; the artifact says which.

// A model's shell, read-only, confined to one folder. Any python script the project ships is allowed rather than
// one directory's worth, because the checkers worth running are wherever a given repository keeps them. One
// double-quoted argument is permitted; `$`, backtick and `\` stay out of it, since inside double quotes sh still
// performs command substitution. The script path is resolved and required to stay inside cwd, so a relative path
// cannot walk out of the folder being assessed.
// A quoted argument is handed to `sh -c`, where `;|&<>()` inside quotes are literal, so excluding them bought no
// safety and refused the real job: every claim in the bench carries `<figure>`, so `settled.py "<the claim>"` was
// refused on exactly the items it exists to answer, while the same call succeeded where the model substituted real
// figures. Command substitution is what must not get through, so `$`, a backtick and a backslash stay out of a
// double-quoted argument, and a single-quoted one admits everything but its own quote.
// Measured on the 2-item bench: Kimi K3 spent all 14 rounds on refusals and hit the cap, Grok 4.7 lost one round.
// Every refused command was read-only. Three shapes did it, so all three are now allowed: one trailing pipe into
// head or tail (the description offers both, and a model naturally pipes), more than one file for wc and cat, and
// `|` inside a quoted grep pattern, which is alternation rather than a pipe. A model that cannot run a plain grep
// looks worse on the benchmark for a reason that is ours, not its.
const Q = "\"[^\"$`\\\\]*\"|'[^']*'";              // a quoted literal with no command substitution
const F = "[\\w./-]+( [\\w./-]+)*";                // one or more bare paths
const ALLOW_BODY = [
  "python3 [\\w./-]+\\.py( --[\\w-]+)*( (" + Q + "))?",
  "ls( -\\w+)*( [\\w./-]+)?",
  "cat " + F,
  "wc -[lc] " + F,
  "head( -n \\d+| -\\d+)? " + F,
  "tail( -n \\d+| -\\d+)? " + F,
  "grep( -\\w+( \\d+)?)* (" + Q + "|[^;|&><`$'\"]+)( " + F + ")?",
  "git --no-pager status( --short)?",
  "git --no-pager log( --oneline)?( -\\d+)?",
].join("|");
export const ALLOW = new RegExp("^(" + ALLOW_BODY + ")( 2>&1)?( \\| (head|tail)( -n \\d+| -\\d+)?)?$");

const inside = (cwd: string, rel: string) => {
  const q = path.resolve(cwd, rel);
  return q === cwd || q.startsWith(cwd + path.sep);
};

// `cat`, `grep`, `wc`, `head` and `tail` all read stdin when called without a file, and the child's stdin is a pipe
// nothing ever writes to, so such a command blocks until the timeout instead of returning. Measured on gpt-6-astra:
// three stalls of 196, 257 and 274 s in one 19-minute run, which is one and two full timeouts back to back, against
// a whole 47-item run of 418 s for Claude Sonnet 5, which happened always to pass a file. Closing stdin returns the
// same command in 0.0 s. A kill also has no exit code, so the old line reported it as `exit 1` with empty output and
// the model could not tell a killed command from one that found nothing.
const SH_TIMEOUT_MS = 30_000;

export const sh = (cmd: string, cwd: string, deny = "") => new Promise<string>((done) => {
  const t = cmd.trim();
  // `off` was never a without-arm: measured on the clean harness, 88% of its item-runs still reached the verdict
  // by running settled.py themselves, so off against tool compared packaging and not access. `none` closes that
  // route, which is the only way the contrast the product claims can be measured at all.
  if (deny && t.includes(deny)) return done(`refused by the harness: ${deny} is not available in this arm. Answer from what you can read for yourself.`);
  // Naming the working directory in the refusal: 47 of 273 shell calls on 2026-09-22 were wasted, and the largest
  // group was `cd <folder> && python3 tools/settled.py ...` by a model that did not know it was already there.
  if (!ALLOW.test(t)) return done(`refused by the harness: only read-only commands and python3 scripts inside the folder are allowed here, one at a time. The working directory is already ${path.basename(cwd)}, so do not cd into it, and do not chain with ; && or ||. A single trailing "| head -n" or "| tail -n" is allowed. Asked: ${cmd}`);
  const script = t.startsWith("python3 ") ? t.split(/\s+/)[1] : "";
  if (script && !inside(cwd, script)) return done(`refused by the harness: ${script} is outside ${path.basename(cwd)}`);
  execFile("/bin/sh", ["-c", `exec </dev/null; ${t}`], { cwd, timeout: SH_TIMEOUT_MS, maxBuffer: 1 << 22 }, (err, out, errOut) => {
    if (err && (err as any).killed) return done(`killed by the harness after ${SH_TIMEOUT_MS / 1000} s. stdin is closed, so pass a file rather than reading standard input, and narrow the command. Asked: ${t}`);
    done(`exit ${err ? (err as any).code ?? 1 : 0}\n${String(out || "")}${errOut ? `\n[stderr]\n${errOut}` : ""}`.slice(0, 20_000));
  });
});

export const settled = (q: string, cwd: string, script: string) => new Promise<string>((done) => {
  execFile("python3", [path.resolve(cwd, script), q], { cwd, timeout: 30_000, maxBuffer: 1 << 20 }, (_e, out) => done(String(out || "").trim()));
});

// A weave result labels its source `<folder>/path/to/file`, and a model handed that citation asks to read exactly
// it. Resolving relative to the extension host's cwd failed every one of those reads.
export const rootNames = (roots: string[]) => `paths are absolute, or begin with a woven folder's name exactly as the weave labels its sources. The woven folders are: ${roots.map((r) => path.basename(r)).join(", ")}`;

export const locate = (p: string, roots: string[]): string | null => {
  const clean = p.trim().replace(/^\.\//, "");
  if (!clean || clean === "." || clean === "..") return null;
  if (path.isAbsolute(clean)) return fs.existsSync(clean) ? clean : null;
  for (const r of roots) {
    const base = path.basename(r);
    if (clean === base) return r;
    if (clean.startsWith(base + "/")) {
      const q = path.join(r, clean.slice(base.length + 1));
      if (fs.existsSync(q)) return q;
    }
  }
  for (const r of roots) { const q = path.join(r, clean); if (fs.existsSync(q)) return q; }
  return null;
};

export const readFile = (p: string, roots: string[], from?: number, to?: number) => {
  const q = locate(p, roots);
  if (!q) return `could not read ${p}: no such file. ${rootNames(roots)}`;
  try {
    const lines = fs.readFileSync(q, "utf8").split("\n");
    const a = Math.max(1, from || 1), b = Math.min(lines.length, to || Math.min(lines.length, a + 199));
    return `${p} lines ${a} to ${b} of ${lines.length}\n` + lines.slice(a - 1, b).join("\n").slice(0, 20_000);
  } catch (e: any) { return `could not read ${p}: ${e.message}`; }
};

export const listDir = (p: string, roots: string[]) => {
  const q = locate(p, roots);
  if (!q) return `could not list ${p}: no such directory. ${rootNames(roots)}`;
  try { return fs.readdirSync(q, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? "/" : "")).join("\n").slice(0, 8000); }
  catch (e: any) { return `could not list ${p}: ${e.message}`; }
};

const SETTLED_TOOL: vscode.LanguageModelChatTool = {
  name: "settled",
  description: "Ask the register's claim ledger whether a published figure still holds. Pass the claim as it is stated, with its figures. Returns the verdict, the deciding artifact's own figures, which figures are superseded, and the correction that decides it; or says no ledger row matches, in which case do not assemble an answer out of passages.",
  inputSchema: { type: "object", properties: { claim: { type: "string", description: "the claim as published, including its figures" } }, required: ["claim"] },
};

export function buildTools(roots: string[], cwd: string, lookup: string, weave = true): vscode.LanguageModelChatTool[] {
  // `paste` withholds every tool, which makes it useless as a control for a chain whose answer is inside a
  // file: the arm cannot open what it was not given. This withholds retrieval only, leaving the shell.
  // `remember` is withheld outright: it writes the model's own answer into the weave, where the next item and the
  // next repeat retrieve it as a note. 14 were written on 2026-09-22 across two models, one of them a verbatim
  // answer to item 1 that then came back as a top hit, so repeats were not independent.
  const woven = weave ? vscode.lm.tools.filter((t) => t.name.startsWith("blackwindow_") && t.name !== "blackwindow_remember") : [];
  return [
    ...woven.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...(lookup ? [SETTLED_TOOL] : []),
    { name: "read_file", description: `Read a file, optionally a line range. ${rootNames(roots)}. A source label from a weave result can be passed straight through.`, inputSchema: { type: "object", properties: { path: { type: "string" }, from: { type: "number" }, to: { type: "number" } }, required: ["path"] } },
    { name: "list_dir", description: `List a directory. ${rootNames(roots)}.`, inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    { name: "run_command", description: `Run a read-only shell command. The working directory is ${path.basename(cwd)}, so its own files are reachable without a prefix and the other folders are not reachable at all; use read_file for those. Allowed: python3 on a script inside this folder, ls, cat, wc, head, tail, grep, git --no-pager status, git --no-pager log.`, inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  ];
}

export function buildCall(roots: string[], cwd: string, lookup: string, deny = "") {
  return async (name: string, a: any): Promise<string> => {
    if (name.startsWith("blackwindow_")) {
      try {
        const r = await vscode.lm.invokeTool(name, { input: a, toolInvocationToken: undefined }, new vscode.CancellationTokenSource().token);
        return r.content.map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : JSON.stringify(p))).join("\n").slice(0, 20_000);
      } catch (e: any) { return `${name} failed: ${e?.message || e}`; }
    }
    if (name === "read_file") return readFile(String(a.path || ""), roots, +a.from || undefined, +a.to || undefined);
    if (name === "list_dir") return listDir(String(a.path || ""), roots);
    if (name === "run_command") return sh(String(a.command || ""), cwd, deny);
    if (name === "settled" && lookup) return settled(String(a.claim || a.query || ""), cwd, lookup);
    return `no such tool: ${name}`;
  };
}

export interface ItemRun {
  items: { n: number; prompt: string }[];
  model: vscode.LanguageModelChat;
  rounds: number;
  preamble: string;
  tools: vscode.LanguageModelChatTool[];
  call: (name: string, args: any) => Promise<string>;
  only?: number[];
  pre?: (prompt: string) => Promise<string>;
  extra?: (it: { n: number; prompt: string }) => string | Promise<string>;
  turn?: () => Record<string, unknown>;
  onItem?: (row: any) => void;
  token?: vscode.CancellationToken;
}

export async function runItems(o: ItemRun): Promise<any[]> {
  const answers: any[] = [];
  for (const it of o.items) {
    if (o.only?.length && !o.only.includes(it.n)) continue;
    if (o.token?.isCancellationRequested) break;
    const t0 = Date.now();
    const pre = o.pre ? await o.pre(it.prompt) : "";
    const extra = o.extra ? await o.extra(it) : "";
    const msgs: vscode.LanguageModelChatMessage[] = [
      vscode.LanguageModelChatMessage.User(o.preamble),
      vscode.LanguageModelChatMessage.User(
        (extra ? `${extra}\n\n---\n\n` : "") +
        (pre ? `${it.prompt}\n\n---\nThe register's claim ledger was consulted for you before you were asked. It is the register's own verdict, not a passage to weigh:\n\n${pre}` : it.prompt)),
    ];
    const made: { name: string; args: any; result?: string }[] = [];
    let seen = pre;
    const stuck: string[] = [];
    let answer = "", why = "";
    for (let r = 0; r < o.rounds; r++) {
      let text = ""; const calls: vscode.LanguageModelToolCallPart[] = [];
      try {
        const res = await o.model.sendRequest(msgs, { tools: o.tools, toolMode: vscode.LanguageModelChatToolMode.Auto, justification: "Running the Sunstone agent assessment" }, o.token ?? new vscode.CancellationTokenSource().token);
        for await (const part of res.stream) { if (part instanceof vscode.LanguageModelToolCallPart) calls.push(part); else if (part instanceof vscode.LanguageModelTextPart) text += part.value; }
      } catch (e: any) { why = `threw${e instanceof vscode.LanguageModelError ? ` [${e.code}]` : ""}: ${e?.message || e}`; break; }
      const t = o.turn?.();
      if (t?.stuck) stuck.push(`r${r}: ${t.stuck}`);
      // An empty stream with no tool calls is a failure the provider did not throw on. One model returned that
      // for all 20 items in 0 seconds and every one was recorded as answered.
      if (!calls.length) { answer = text.trim(); why = answer ? "answered" : "returned nothing"; break; }
      msgs.push(vscode.LanguageModelChatMessage.Assistant([...(text ? [new vscode.LanguageModelTextPart(text)] : []), ...calls]));
      const parts: vscode.LanguageModelToolResultPart[] = [];
      // 4,000 characters, not 600: reading a tool's output off this field once said a checker "holds no answer"
      // when its full 6,435 characters carried the corrected figure for 6 of 12 items.
      for (const c of calls) { const res = await o.call(c.name, c.input || {}); seen += "\n" + res; made.push({ name: c.name, args: c.input, result: res.slice(0, 4000) }); parts.push(new vscode.LanguageModelToolResultPart(c.callId, [new vscode.LanguageModelTextPart(res)])); }
      msgs.push(vscode.LanguageModelChatMessage.User(parts));
      if (r === o.rounds - 1) why = `hit the ${o.rounds} round cap`;
    }
    // Not "is the answer right", which needs the key, but "does every value it asserts appear in something it was
    // shown", which is decidable here. Measured only; nothing is withheld or warned about on this pass.
    const VAL = /\d+(?:[.,]\d+)*(?:\s*\/\s*\d+)?|[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|\b[A-Z][A-Z0-9_]{2,}\b/g;
    const flat = (s: string) => s.toLowerCase().replace(/(\d)[,\u00a0\u202f\u2009 ](?=\d{3}(?!\d))/g, "$1");
    const shown = flat(seen);
    const asserted = [...new Set((answer.match(VAL) || []).map((x) => x.replace(/\s+/g, "")))];
    const unsupported = asserted.filter((v) => !shown.includes(flat(v)));
    const row = { n: it.n, q: it.prompt.slice(0, 90), answer: answer || "(none)", why, calls: made.length, tools: made.map((c) => c.name), stuck, secs: Math.round((Date.now() - t0) / 10) / 100, drift: { asserted: asserted.length, unsupported }, turn: { ...(o.turn?.() || {}) } };
    answers.push({ ...row, answerFull: answer, callsFull: made, settled: pre || undefined });
    o.onItem?.(row);
  }
  return answers;
}

// Whatever standing instructions the workspace actually carries, rather than one repository's file. A project
// with none is assessed with none, which is a valid arm rather than an error.
const INSTRUCTIONS = [".github/copilot-instructions.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"];

export function preamble(roots: string[], withRules: boolean, only?: string[], agentFrom?: string | false): { text: string; agent: string; rules: string[] } {
  const found: string[] = [], parts: string[] = [];
  if (withRules) {
    // Pinned, or whatever the workspace happens to carry. Pinning matters because adding a folder changes the
    // preamble and so changes the population: four files here are 14,446 bytes against one folder's 8,370.
    const want = only?.length
      ? only.map((p) => (path.isAbsolute(p) ? p : roots.map((r) => path.join(r, p)).find(fs.existsSync) || p))
      : roots.flatMap((r) => INSTRUCTIONS.map((rel) => path.join(r, rel)));
    for (const p of want) {
      if (!fs.existsSync(p)) continue;
      found.push(p);
      parts.push(fs.readFileSync(p, "utf8"));
    }
  }
  const agentFile = agentFrom === false ? "" : (agentFrom || process.env.SUNSTONE_AGENT || path.join(process.env.HOME || "", "Library/Application Support/Code/User/prompts/weave.agent.md"));
  const agent = agentFile && fs.existsSync(agentFile) ? fs.readFileSync(agentFile, "utf8").replace(/^---[\s\S]*?---\s*/, "") : "";
  const where = roots.length
    ? `\n\nThe folders open here are:\n${roots.map((r) => `  ${path.basename(r)}  at ${r}`).join("\n")}`
    : "";
  return {
    agent: agent ? path.basename(agentFile) : "none",
    rules: found,
    text: `${agent ? agent.trim() + "\n\n---\n\n" : ""}${parts.join("\n\n---\n\n")}${where}`,
  };
}

// `Sunstone: Run the assessment`, in the editor the user works in. Everything is chosen the way a person chooses
// it, from pickers, rather than from environment variables a batch script sets.
//
// It also runs without a person. Dropping a queue file at out/test/assess.queue.json runs the grid it names and
// renames it aside, so a batch is started from a terminal and never touches a picker.

export interface Cell {
  model: string;
  bench?: string;   // absolute, folder-relative, or a bare name looked for under each folder and its bench/
  cwd?: string;     // the folder run_command works in; default the folder the queue was found in
  lookup?: string;  // a script answering a claim; the settled tool is offered only when one is given and exists
  rulesFrom?: string[];  // exact instruction files to use; without it, every one the open folders carry
  agent?: string | false;  // a custom agent's instructions; false runs without them, as an arm
  // The window-pressure arm. Instead of the weave, the model is handed the folder that holds the answer,
  // truncated by its own window, and no tools at all. That is oracle-assisted and so an upper bound on what
  // pasting can do: a person without a weave does not know which folder to paste. The register is 19.5M tokens
  // against windows from 32,768 to 982,833, so the question is what happens as the folder crosses the window.
  paste?: { key: string; scope?: "folder" | "repo" | "fill" | "corpus"; share?: number; window?: number };
  /** false withholds the blackwindow_* tools and keeps read_file, list_dir and run_command. */
  weave?: boolean;
  settled?: "tool" | "off" | "none";
  rounds?: number;
  repeats?: number;
  rules?: boolean;
}
export interface Spec { runs: Cell[]; needs?: string[]; judge?: import("./judge").JudgeSpec | import("./judge").JudgeSpec[] }
// A queue outlives the build that wrote it: an extension host from before `paste` existed drops the field and
// runs a weave arm under a paste label. Naming the capability lets the old host fail instead.
const CAPABILITIES = ["paste", "paste:repo", "paste:tokens", "paste:corpus", "rulesFrom", "agentOff", "weaveOff", "settledNone"];

/** The arm's name, for the artifact label and for the resume key, from one place. A key that omits part
 *  of the arm silently drops the cell: the weaveOff cell keyed as `off`, inherited the weave arm's three
 *  finished runs, and the grid reported success having run nothing. */
function armName(c: Pick<Cell, "paste" | "weave" | "settled">, hasLookup: boolean): string {
  if (c.paste) return `paste:${c.paste.scope ?? "folder"}`;
  const base = c.settled === "none" ? "none" : hasLookup ? "tool" : "off";
  if (c.weave === false) return base === "off" ? "weaveOff" : `${base}:weaveOff`;
  return base;
}

type Deps = { weave: { ensure(timeoutMs?: number): Promise<void>; host: { bw<T>(m: string, a: any[], t?: number): Promise<T> } }; provider: { turn: Record<string, unknown> } };

const folders = () => (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);

function findBench(name: string, roots: string[]): string {
  if (path.isAbsolute(name)) {
    if (fs.existsSync(name)) return name;
    throw new Error(`no item set at ${name}`);
  }
  for (const r of roots) for (const p of [path.join(r, name), path.join(r, "bench", name)]) if (fs.existsSync(p)) return p;
  throw new Error(`no item set ${name} in ${roots.map((r) => path.basename(r)).join(", ") || "any open folder"}`);
}

// An item set is {items:[{n,prompt}]}, a bare array of those, or a bare array of strings.
function loadItems(file: string): { n: number; prompt: string }[] {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.items;
  if (!Array.isArray(list) || !list.length) throw new Error(`${path.basename(file)} carries no items`);
  return list.map((x: any, i: number) => ({ n: typeof x?.n === "number" ? x.n : i + 1, prompt: String(x?.prompt ?? x?.question ?? x) }));
}

// The arm decides, not the path. A queue that named a lookup script on every cell and set settled "off" on half
// of them handed the tool to all 13 runs of 2026-09-20, so there was no baseline and the label on the artifact
// was the only honest thing in the grid.
function findLookup(c: Cell, cwd: string): string {
  if (c.settled === "off" || c.settled === "none") return "";
  if (c.lookup) return fs.existsSync(path.resolve(cwd, c.lookup)) ? c.lookup : "";
  if (c.settled !== "tool") return "";
  const guess = path.join("tools", "settled.py");
  return fs.existsSync(path.join(cwd, guess)) ? guess : "";
}

// Strict, and it names what was offered. A silent fall back to the first model ran a whole arm on the wrong one
// on 2026-09-19 and the score was plausible.
async function pickModel(want: string): Promise<vscode.LanguageModelChat> {
  const all = await vscode.lm.selectChatModels({});
  const m = all.find((x) => x.id === want || x.name === want || x.id.endsWith("|" + want));
  if (!m) throw new Error(`no model ${want}; the editor offers ${all.map((x) => `${x.vendor}/${x.id}`).join(", ") || "none"}`);
  return m;
}

// What a person without a weave does: paste the material and hope it fits. Three scopes, because they answer
// different questions. "folder" is the directory the key's artifact sits in, oracle-assisted and small, so it
// measures whether retrieval costs anything when the material would have fitted anyway. "fill" is that folder
// first and then the rest of the repository until the window is full, so the answer is always present and the
// only variable is how much surrounds it. "repo" is sorted order with no oracle placement, under which the
// answer's own file survives 0 of 8 items below 936k tokens, so it measures refusal against invention rather
// than a score. Files are taken in a fixed order so two runs of a cell paste the same bytes.
function pasteFor(c: Cell, cwd: string, roots: string[], model: vscode.LanguageModelChat) {
  const key = JSON.parse(fs.readFileSync(path.isAbsolute(c.paste!.key) ? c.paste!.key : path.join(cwd, c.paste!.key), "utf8"));
  // maxInputTokens is what the picker advertises, not what the server runs: gemma advertises 32,768 and serves
  // 8,192, and Qwen3-30B-A3B advertised 65,536 and 131,072 in two cells of one sweep against 40,960 served.
  const budgetTok = Math.floor((c.paste!.window ?? model.maxInputTokens) * (c.paste!.share ?? 0.6));
  // Four characters per token overshot every budget by a third to four fifths: this material measures 2.17 to
  // 3.02 characters per token. Assemble on the low estimate, then trim on the model's own count.
  const budget = budgetTok * 2;
  const scope = c.paste!.scope ?? "folder";
  const SKIP = new Set(["node_modules", "target", "out", "dist", "build", ".git", "artifacts"]);
  return async (it: { n: number }) => {
    const label = key.order?.[it.n - 1] ?? String(it.n);
    const named = String(key.items?.[label]?.artifact || "").split(/[,;]/)[0].trim().split(" ")[0];
    // The key names artifacts in other repositories than cwd, so resolve the way locate() does or L5 and D3
    // paste nothing and score a zero that looks like a model failure.
    // path.resolve, because path.join keeps the trailing slash a key writes on a directory artifact and the
    // prefix test then compares against a doubled separator that never matches.
    const found = named ? locate(named, roots) || (fs.existsSync(path.resolve(cwd, named)) ? path.resolve(cwd, named) : null) : null;
    const art = found ? path.resolve(found) : null;
    if (!art) return { text: "", bytes: 0, files: 0, cut: 0, answerIn: false, root: "" };
    const repo = roots.find((r) => art.startsWith(r + path.sep)) || cwd;
    // A key may name a directory as the artifact, as L6 does with evidence/reference_500/. Treating it as a file
    // put the answer's own folder outside the paste and reported a capacity failure that was a path type.
    const isDir = fs.statSync(art).isDirectory();
    const home = isDir ? art : path.dirname(art);
    const files: string[] = [];
    const walk = (d: string, into: string[]) => {
      let ents: fs.Dirent[] = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, into); else if (/\.(md|json|py|ts|txt)$/.test(e.name)) into.push(p);
      }
    };
    walk(scope === "folder" ? home : repo, files);
    // The baseline a person without a weave actually has: no idea which of the 2,630 sources holds the answer,
    // so paste what fits of everything. The weave searches all six roots, so this is the arm it must be read against.
    if (scope === "corpus") { files.length = 0; for (const r of roots) walk(r, files); }
    // Fill puts the answer's folder at the front and pads with the rest, so truncation removes distractors only.
    if (scope === "fill") files.sort((a, b) => Number(b.startsWith(home + path.sep)) - Number(a.startsWith(home + path.sep)));
    const dir = scope === "folder" ? home : repo;
    const rel = (p: string) => (scope === "corpus" ? path.relative(path.dirname(roots.find((r) => p.startsWith(r + path.sep)) || repo), p) : path.relative(repo, p));
    let out = `You have been given ${scope === "corpus" ? "as much of the woven folders as fits in your context" : path.basename(repo) + (scope === "folder" ? "/" + path.relative(repo, dir) : "")} below. There are no tools. Answer from this material.\n\n`;
    let cut = 0, n = 0, answerIn = false;
    for (const p of files) {
      let body = ""; try { body = fs.readFileSync(p, "utf8"); } catch { continue; }
      const head = `\n\n===== ${rel(p)} =====\n`;
      if (out.length + head.length + body.length > budget) { cut += body.length; continue; }
      out += head + body; n++;
      if (isDir ? p.startsWith(art + path.sep) : p === art) answerIn = true;
    }
    if (cut) out += `\n\n[${cut.toLocaleString()} characters did not fit in the window and were left out]`;
    // Fill puts the answer first, so trimming the tail takes padding rather than the answer.
    let tok = await model.countTokens(out);
    for (let guard = 0; tok > budgetTok && out.length > 2000 && guard < 6; guard++) {
      out = out.slice(0, Math.floor(out.length * (budgetTok / tok) * 0.95));
      tok = await model.countTokens(out);
    }
    return { text: out, bytes: out.length, tokens: tok, budget: budgetTok, files: n, cut, answerIn, root: scope === "corpus" ? "corpus" : rel(dir) || path.basename(repo) };
  };
}

async function runCell(c: Cell, outDir: string, dep: Deps, token?: vscode.CancellationToken, say?: (s: string) => void): Promise<string[]> {
  const roots = folders();
  const cwd = c.cwd ? (path.isAbsolute(c.cwd) ? c.cwd : path.join(roots[0] || process.cwd(), c.cwd)) : (roots[0] || process.cwd());
  const benchFile = findBench(c.bench || "agent_assessment.json", roots);
  const items = loadItems(benchFile);
  const rounds = c.rounds || 14;
  const lookup = findLookup(c, cwd);
  const model = await pickModel(c.model);
  const { text, agent, rules } = preamble(roots, c.rules !== false, c.rulesFrom, c.agent);
  const paste = c.paste ? pasteFor(c, cwd, roots, model) : undefined;
  const tools = paste ? [] : buildTools(roots, cwd, lookup, c.weave !== false);
  const call = buildCall(roots, cwd, lookup, c.settled === "none" ? "settled.py" : "");
  // Up before the count, or the weave arm's first items run against a store that is not open yet and the
  // artifact records sources: -1. Every run of 2026-09-21 recorded -1.
  const sources = await dep.weave.ensure().then(() => dep.weave.host.bw<any[]>("sources", [])).then((s) => s.length).catch(() => -1);
  // The arm name carries weaveOff, because line 370 records c.weave and an arm whose label and tool set
  // disagree is worse than no arm: the first draft of this call dropped c.weave and would have run the
  // weave under a no-weave label.
  const arm = armName(c, !!lookup);
  const withAgent = c.agent === false ? "noagent" : "agent";
  const written: string[] = [];
  for (let i = 0; i < (c.repeats || 1); i++) {
    if (token?.isCancellationRequested) break;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    say?.(`${model.name} ${arm} ${i + 1}/${c.repeats || 1}`);
    const results: Record<string, unknown> = {
      run: { id: stamp, surface: "editor", bench: path.basename(benchFile), benchPath: benchFile, items: items.length, rounds, settled: arm, lookup, agent, rules, sources, cwd, roots, repeat: i + 1, paste: c.paste || null, weave: c.weave !== false, window: model.maxInputTokens },
      model: { id: model.id, name: model.name, vendor: model.vendor, maxIn: model.maxInputTokens },
    };
    const answers = await runItems({ items, model, rounds, preamble: text, tools, call, token, extra: paste && (async (it) => (await paste(it)).text), turn: () => ({ ...dep.provider.turn }) });
    // Whether the answer's own file survived truncation decides how a paste failure reads: below the cut it is
    // capacity, above it it is reading.
    if (paste) for (const a of answers) { const p = await paste(a); (a as any).paste = { bytes: p.bytes, tokens: p.tokens, budget: p.budget, files: p.files, cut: p.cut, answerIn: p.answerIn, root: p.root, fits: p.cut ? p.bytes / (p.bytes + p.cut) : 1 }; }
    results.answers = answers;
    results.done = { items: answers.length, answered: answers.filter((a) => a.why === "answered").length, secs: answers.reduce((s, a) => s + a.secs, 0) };
    const file = path.join(outDir, `${stamp}-editor-${model.name.replace(/[^\w.-]/g, "_")}-${arm}-${withAgent}.json`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(file + ".tmp", JSON.stringify(results, null, 1));
    fs.renameSync(file + ".tmp", file);
    // One line per run as it finishes rather than a single write at the end, so an interrupted batch keeps what it did.
    fs.appendFileSync(path.join(outDir, "batch.jsonl"), JSON.stringify({ at: new Date().toISOString(), pick: c.model, model: model.name, vendor: model.vendor, bench: path.basename(benchFile), settled: arm, agent: withAgent, repeat: i + 1, answered: (results.done as any).answered, secs: (results.done as any).secs, file: path.basename(file) }) + "\n");
    written.push(file);
  }
  return written;
}

async function runSpec(spec: Spec, outDir: string, dep: Deps): Promise<string[]> {
  const missing = (spec.needs || []).filter((n) => !CAPABILITIES.includes(n));
  if (missing.length) throw new Error(`this build cannot honour ${missing.join(", ")}; reload the window after npm run build`);
  // What a previous host already finished, so a grid resumes rather than repeating runs that cost money.
  const done = new Map<string, number>();
  const log = path.join(outDir, "batch.jsonl");
  if (fs.existsSync(log)) for (const line of fs.readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const d = JSON.parse(line);
      // A run that answered nothing did not happen: the provider can return an empty stream without throwing, and
      // four such runs were written as finished on 2026-09-22, which a resume would then skip forever. Counting
      // them as done is how a silent failure becomes a permanent hole in a grid.
      if (d.file && d.answered !== 0) { const k = `${d.pick}|${d.settled}|${d.bench}|${d.agent || "agent"}`; done.set(k, (done.get(k) || 0) + 1); }
    } catch { /* a half-written line from a killed host */ }
  }
  const todo = spec.runs.map((c) => {
    // The arm must be whole in the key. Without the paste scope a paste cell inherits the completed weave runs
    // of the same model and is dropped to zero repeats, which reads as a finished grid.
    const armOf = armName(c, c.settled === "tool");
    const k = `${c.model}|${armOf}|${path.basename(c.bench || "agent_assessment.json")}|${c.agent === false ? "noagent" : "agent"}`;    return { ...c, repeats: Math.max(0, (c.repeats || 1) - (done.get(k) || 0)) };
  }).filter((c) => c.repeats > 0);
  const total = todo.reduce((s, c) => s + (c.repeats || 1), 0);
  if (!total) return [];
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Assessment: ${total} runs`, cancellable: true }, async (progress, token) => {
    const out: string[] = [];
    for (const c of todo) {
      try {
        out.push(...await runCell(c, outDir, dep, token, (s) => progress.report({ message: `${out.length + 1} of ${total}: ${s}` })));
      } catch (e: any) {
        // A cell that cannot start must not take the rest of the grid with it.
        fs.mkdirSync(outDir, { recursive: true });
        fs.appendFileSync(path.join(outDir, "batch.jsonl"), JSON.stringify({ at: new Date().toISOString(), cell: c, failed: String(e?.message || e) }) + "\n");
      }
      if (token.isCancellationRequested) break;
    }
    return out;
  });
}

export function registerAssess(context: vscode.ExtensionContext, api: Deps) {
  const defaultOut = () => path.join(folders()[0] || context.globalStorageUri.fsPath, ".sunstone");

  context.subscriptions.push(vscode.commands.registerCommand("sunstone.assess", async (spec?: Spec) => {
    const roots = folders();
    if (!roots.length) { vscode.window.showErrorMessage("Open a folder to assess."); return; }
    if (spec?.runs?.length) return runSpec(spec, defaultOut(), api);

    // Every item set the workspace offers, wherever it keeps them.
    const sets: string[] = [];
    for (const r of roots) for (const d of [r, path.join(r, "bench")]) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) if (f.endsWith(".json") && !f.includes("key") && !f.includes("basis") && /assess|bench|eval|qa/i.test(f)) sets.push(path.join(d, f));
    }
    if (!sets.length) { vscode.window.showErrorMessage("No item set found. Expected a JSON file of {items:[{n,prompt}]} in an open folder or its bench/ directory."); return; }
    const bench = await vscode.window.showQuickPick(sets.map((s) => ({ label: path.basename(s), description: path.dirname(s), s })), { title: "Which item set?" });
    if (!bench) return;

    const models = await vscode.lm.selectChatModels({});
    if (!models.length) { vscode.window.showErrorMessage("No chat models are available in this window."); return; }
    const chosen = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: m.vendor, detail: `${m.id}  ${m.maxInputTokens.toLocaleString()} tokens in`, m })),
      { title: "Which model?", matchOnDescription: true });
    if (!chosen) return;
    const cwd = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots.map((r) => ({ label: path.basename(r), description: r, r })), { title: "Which folder do commands run in?" }))?.r;
    if (!cwd) return;
    const rounds = +((await vscode.window.showInputBox({ title: "Tool rounds per item", value: "14" })) || 0);
    if (!rounds) return;
    const repeats = +((await vscode.window.showInputBox({ title: "How many runs of it?", value: "1" })) || 0);
    if (!repeats) return;
    const files = await runSpec({ runs: [{ model: chosen.m.id, bench: bench.s, cwd, rounds, repeats, settled: "tool" }] }, defaultOut(), api);
    const open = await vscode.window.showInformationMessage(`Assessment: ${files.length} run(s) written.`, "Open the last");
    if (open && files.length) vscode.window.showTextDocument(await vscode.workspace.openTextDocument(files[files.length - 1]));
  }));

  // Queue files, so a grid is started from a terminal with no window interaction. A queue becomes
  // assess.running.json for the duration and is only filed away once the grid finishes, because renaming it
  // aside on pickup lost a 13-run spec when an extension reload killed the host mid-run. A running marker left
  // by a dead host is resumed on activation, and runs already in batch.jsonl are not repeated.
  const RUNNING = "assess.running.json";
  let busy = false;
  const take = async (uri: vscode.Uri) => {
    if (busy || !fs.existsSync(uri.fsPath)) return;
    busy = true;
    const outDir = path.dirname(uri.fsPath);
    const running = path.join(outDir, RUNNING);
    try {
      if (uri.fsPath !== running) fs.renameSync(uri.fsPath, running);
      const spec = JSON.parse(fs.readFileSync(running, "utf8")) as Spec;
      const files = await runSpec(spec, outDir, api);
      // A queue with no runs left still judges the artifacts beside it that carry no verdict. A pass naming its
      // own artifacts keeps them. Passing an empty list instead fell through to a picker, which with nobody
      // watching returns at once, so a judging pass reported success having judged nothing.
      const unjudged = () => fs.readdirSync(outDir)
        .filter((f) => f.endsWith(".json") && !f.includes("judged") && !f.startsWith("assess."))
        .map((f) => path.join(outDir, f))
        .filter((f) => !fs.existsSync(f.replace(/\.json$/, ".judged-blind.json")));
      // Blind and keyed in one queue, because a blind score means nothing until it has been checked against a
      // keyed one on the same runs.
      for (const j of ([] as any[]).concat(spec.judge || [])) {
        const artifacts = j.artifacts?.length ? j.artifacts : (files.length ? files : unjudged());
        if (!artifacts.length) throw new Error("a judging pass resolved no artifacts");
        await vscode.commands.executeCommand("sunstone.judge", { ...j, artifacts });
      }
      fs.renameSync(running, path.join(outDir, `assess.${Date.now()}.done.json`));
      vscode.window.showInformationMessage(`Assessment queue finished: ${files.length} run(s) in ${path.basename(outDir)}.`);
    } catch (e: any) {
      vscode.window.showErrorMessage(`Assessment queue failed: ${e?.message || e}`);
    } finally { busy = false; }
  };
  for (const r of folders()) {
    for (const rel of [".sunstone", path.join("out", "test", "assess")]) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.join(r, rel)), "assess.queue.json"));
      w.onDidCreate(take); w.onDidChange(take);
      context.subscriptions.push(w);
      for (const name of [RUNNING, "assess.queue.json"]) {
        const here = path.join(r, rel, name);
        if (fs.existsSync(here)) take(vscode.Uri.file(here));   // interrupted, or left while the window was shut
      }
    }
  }
}
