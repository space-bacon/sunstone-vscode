import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { CodeItem, grepIndex, grepTop, isGold } from "./localise";

// A retrieval set in bench/code_qa.json's shape, written from a repository nobody here has read. The split
// that makes it trustworthy: the ANSWER is a definition site found by scanning files, and a model is used
// only to phrase the QUESTION. Nothing a model says decides whether an answer is right.

const EXCLUDE = "**/{node_modules,.git,.hg,.svn,dist,out,build,target,.next,.nuxt,.venv,.venv-*,venv,env,site-packages,.tox,eggs,third_party,vendor,bower_components,__pycache__,.mypy_cache,.pytest_cache,.vscode-test,coverage,.cache,Pods,DerivedData}/**";

/** The files git tracks, which is the only reliable statement of what a repository's own code is. An exclude
 *  list missed `.venv-tools/lib/python3.12/site-packages` and put three PyObjC definitions in a five-item set.
 *  Undefined where the folder is not a git repository, and the glob above carries it instead. */
function tracked(folder: string): Promise<Set<string> | undefined> {
  if (!fs.existsSync(path.join(folder, ".git"))) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile("git", ["-C", folder, "ls-files", "-z"], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(undefined);
      resolve(new Set(stdout.split("\0").filter(Boolean)));
    });
  });
}

type Pat = { re: RegExp; kind: string };
// A method body opening on the same line is required, and the keywords are excluded by name, because the
// alternative reading of `  foo(bar) {` is a call and a wrong gold is worse than a missed one.
const NOT_A_DEF = /^(if|for|while|switch|catch|return|function|constructor|else|do|try|with|yield|await|typeof|new)$/;
const TS: Pat[] = [
  { re: /^\s*export\s+(?:async\s+)?function\s+(\w+)/, kind: "function" },
  { re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/, kind: "class" },
  { re: /^\s*export\s+(?:type|interface)\s+(\w+)/, kind: "type" },
  { re: /^\s*(?:async\s+)?function\s+(\w+)\s*\(/, kind: "function" },
  { re: /^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/, kind: "function" },
  { re: /^\s*export\s+(?:const|let)\s+(\w+)\s*[:=]/, kind: "const" },
  { re: /^\s{2,}(?:(?:public|private|protected|static|readonly|override|abstract)\s+)*(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*\{/, kind: "method" },
];
const LANGS: Record<string, Pat[]> = {
  // .html is here for a single-file engine: its module script holds ordinary functions and classes.
  ts: TS, tsx: TS, js: TS, jsx: TS, mjs: TS, html: TS,
  py: [
    { re: /^\s*def\s+(\w+)\s*\(/, kind: "function" },
    { re: /^\s*class\s+(\w+)\s*[(:]/, kind: "class" },
  ],
  rs: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, kind: "fn" },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/, kind: "type" },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/, kind: "func" },
    { re: /^type\s+(\w+)\s+/, kind: "type" },
  ],
};

// Names that exist in every repository and in most files of one. A question about `handler` has no single
// right answer even where the scan finds only one definition of it.
const GENERIC = new Set(("main run test tests setup teardown init new default index handler handle render create update delete remove " +
  "get set has add list load save start stop close open read write parse format build make tostring constructor value name type " +
  "data error result options config clone equals hash next done value_of from_str serialize deserialize").split(" "));

type Def = { symbol: string; kind: string; abs: string; rel: string; line: number };

/** Every definition the patterns can see, with the folder-name-prefixed path the store uses as a source key. */
export async function scanDefs(folder: string, token?: vscode.CancellationToken): Promise<{ defs: Def[]; files: number; git: boolean }> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, `**/*.{${Object.keys(LANGS).join(",")}}`), EXCLUDE);
  const keep = await tracked(folder);
  const defs: Def[] = [];
  let files = 0;
  for (const u of uris) {
    if (token?.isCancellationRequested) break;
    if (keep && !keep.has(path.relative(folder, u.fsPath))) continue;
    const ext = path.extname(u.fsPath).slice(1).toLowerCase();
    const pats = LANGS[ext]; if (!pats) continue;
    let text: string;
    try { const st = fs.statSync(u.fsPath); if (st.size > 1_000_000) continue; text = fs.readFileSync(u.fsPath, "utf8"); } catch { continue; }
    files++;
    const rel = path.basename(folder) + "/" + path.relative(folder, u.fsPath);
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) for (const p of pats) {
      const m = p.re.exec(lines[i]);
      if (m) { if (!NOT_A_DEF.test(m[1])) defs.push({ symbol: m[1], kind: p.kind, abs: u.fsPath, rel, line: i + 1 }); break; }
    }
  }
  return { defs, files, git: !!keep };
}

/** Definitions whose symbol occurs exactly once across the whole scan, so the gold file is not a choice. */
export function unique(defs: Def[], minLen = 5): Def[] {
  const by = new Map<string, Def[]>();
  for (const d of defs) {
    if (d.symbol.length < minLen || GENERIC.has(d.symbol.toLowerCase())) continue;
    const k = d.symbol.toLowerCase();
    (by.get(k) || by.set(k, []).get(k)!).push(d);
  }
  return [...by.values()].filter((v) => v.length === 1).map((v) => v[0]);
}

/** Parts of a symbol a question must also avoid: `parsePairing` leaks through "pairing" as surely as through
 *  its whole name. */
function parts(symbol: string): string[] {
  return [...new Set(symbol.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).map((s) => s.toLowerCase()))].filter((s) => s.length >= 4);
}

/** Textual, not semantic: does the question hand over the answer. */
export function leaks(q: string, d: Def): string {
  const low = q.toLowerCase();
  const base = path.basename(d.rel), stem = base.replace(/\.\w+$/, "");
  if (low.includes(d.symbol.toLowerCase())) return "names the symbol";
  for (const p of parts(d.symbol)) if (low.includes(p)) return `contains "${p}"`;
  if (low.includes(base.toLowerCase())) return "names the file";
  if (stem.length >= 4 && low.includes(stem.toLowerCase())) return "names the file stem";
  if (low.includes(d.rel.toLowerCase())) return "names the path";
  return "";
}

function body(d: Def, maxLines = 30, maxChars = 1800): string {
  let text: string;
  try { text = fs.readFileSync(d.abs, "utf8"); } catch { return ""; }
  return text.split("\n").slice(d.line - 1, d.line - 1 + maxLines).join("\n").slice(0, maxChars);
}

const ASK = (d: Def, src: string) => `Here is a definition from a codebase.

\`\`\`
${src}
\`\`\`

Write the one question a developer would ask to find this code, as in "Where is a pairing line parsed into url, key and name?" or "Which function streams a chat completion for the model picker?".

Rules, all of them binding:
- Describe what the code DOES. Do not use the name "${d.symbol}" or any word inside it.
- Do not name the file, the path, or any identifier that appears in the snippet.
- One sentence, under 20 words, ending in a question mark.
Reply with the question and nothing else.`;

export async function generate(opts: {
  folder: string;
  model: vscode.LanguageModelChat;
  want: number;
  token: vscode.CancellationToken;
  report?: (s: string) => void;
}): Promise<{ items: CodeItem[]; scanned: number; candidates: number; git: boolean; rejected: Record<string, number> }> {
  const { folder, model, want, token } = opts;
  opts.report?.("reading the folder");
  const { defs, files, git } = await scanDefs(folder, token);
  const cands = unique(defs);
  // Spread the picks over files rather than taking the first N, which would put every item in one module.
  const byFile = new Map<string, Def[]>();
  for (const d of cands) (byFile.get(d.rel) || byFile.set(d.rel, []).get(d.rel)!).push(d);
  const order: Def[] = [];
  for (let i = 0; order.length < cands.length; i++) {
    let took = false;
    for (const list of byFile.values()) if (list[i]) { order.push(list[i]); took = true; }
    if (!took) break;
  }

  const grep = await grepIndex([folder]);
  const items: CodeItem[] = [];
  const rejected: Record<string, number> = {};
  const repo = path.basename(folder);
  for (const d of order) {
    if (token.isCancellationRequested || items.length >= want) break;
    const src = body(d); if (!src.trim()) continue;
    opts.report?.(`${items.length + 1} of ${want}: ${d.rel}`);
    let q = "";
    for (let attempt = 0; attempt < 2 && !q; attempt++) {
      let text = "";
      try {
        const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(ASK(d, src))], {}, token);
        for await (const p of res.text) text += p;
      } catch (e: any) { rejected[`model: ${e?.message || e}`] = (rejected[`model: ${e?.message || e}`] || 0) + 1; break; }
      const cand = text.trim().split("\n").map((s) => s.trim()).find((s) => s.endsWith("?")) || "";
      const words = cand.split(/\s+/).length;
      const why = !cand ? "no question returned" : words < 5 || words > 30 ? `${words} words` : leaks(cand, d);
      if (why) { rejected[why] = (rejected[why] || 0) + 1; continue; }
      q = cand;
    }
    if (!q) continue;
    // Recorded, never a filter. Dropping the items grep solves would hand the grep arm a zero it did not earn,
    // and grep is the baseline the engine is measured against.
    const g = grepTop(grep, q);
    items.push({ id: `${repo}-${String(items.length + 1).padStart(2, "0")}`, q, file: d.rel, symbol: d.symbol, line: d.line, repo, ...(g ? { grepTop: g, grepHit: isGold(g, d.rel) } : {}) } as CodeItem);
  }
  return { items, scanned: files, candidates: cands.length, git, rejected };
}

export function registerGenerate(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand("sunstone.generateCodeSet", async () => {
    const roots = vscode.workspace.workspaceFolders || [];
    if (!roots.length) { vscode.window.showErrorMessage("Open a folder to generate a set from."); return; }
    const folder = roots.length === 1 ? roots[0].uri.fsPath
      : (await vscode.window.showQuickPick(roots.map((r) => ({ label: r.name, description: r.uri.fsPath, p: r.uri.fsPath })), { title: "Which repository?" }))?.p;
    if (!folder) return;

    const models = await vscode.lm.selectChatModels({});
    if (!models.length) { vscode.window.showErrorMessage("No chat models are available in this window."); return; }
    const chosen = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: m.vendor, detail: `${m.id}  writes the questions; it never decides an answer`, m })),
      { title: "Which model phrases the questions?", matchOnDescription: true });
    if (!chosen) return;
    const want = +((await vscode.window.showInputBox({ title: "How many items?", value: "20" })) || 0);
    if (!want) return;

    const target = await vscode.window.showSaveDialog({
      title: "Where to write the set",
      defaultUri: vscode.Uri.file(path.join(folder, "bench", `code_qa_${path.basename(folder)}.json`)),
      filters: { JSON: ["json"] },
    });
    if (!target) return;

    const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Generating a set from ${path.basename(folder)}`, cancellable: true },
      (progress, token) => generate({ folder, model: chosen.m, want, token, report: (message) => progress.report({ message }) }));

    if (!out.items.length) { vscode.window.showErrorMessage(`No items: ${out.candidates} candidate definitions in ${out.scanned} files, all rejected (${JSON.stringify(out.rejected)}).`); return; }
    fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
    const tmp = target.fsPath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(out.items, null, 2) + "\n");
    fs.renameSync(tmp, target.fsPath);
    const grepHits = out.items.filter((i: any) => i.grepHit).length;
    const pick = await vscode.window.showInformationMessage(
      `${out.items.length} items from ${out.candidates} uniquely defined symbols in ${out.scanned} ${out.git ? "tracked" : "scanned"} files. Grep alone lands ${grepHits} of ${out.items.length} at rank 1.${out.git ? "" : " Not a git repository, so dependency directories are excluded by name only; check the paths."}`,
      "Open it");
    if (pick) vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  }));
}
