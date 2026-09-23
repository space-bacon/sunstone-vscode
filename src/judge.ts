import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

// Judging an assessment run without a hand-written key, so the instrument works on a repository nobody has
// written accept criteria for. Several models judge each answer and the pool decides.
//
// Two modes, and the second only means something because of the first. Keyed judging is given the accept and
// fail criteria and is scored against them, which measures the judges. Blind judging sees the question, the
// answer and the tool results the answer was built from, and decides whether the answer is responsive and
// supported. Agreement between the two on the same runs is what says whether blind judging can be trusted
// where no key exists; without that comparison a blind verdict is an opinion with a number attached.
//
// A judge never sees which model wrote the answer, and by default a model does not sit on its own pool.

export interface JudgeSpec {
  judges?: string[];     // model ids; default every model the blackwindow provider offers
  artifacts?: string[];  // artifact paths; default every unjudged one beside the queue
  key?: string;          // accept/fail criteria; keyed mode when given, blind when not
  selfJudge?: boolean;   // let a model judge its own answers, default false
  maxResult?: number;    // characters of tool output shown to a judge, default 6000
}

interface Verdict { judge: string; ok: boolean | null; why: string }

const RUBRIC_BLIND = `You are scoring one answer produced by an AI agent working in a code repository.
You see the question, the agent's answer, and the tool output the agent actually retrieved.

Score it "good" only if BOTH hold:
1. It answers the question that was asked, rather than a neighbouring one.
2. Every figure, file path and name it asserts appears in the tool output it was shown. An answer that
   states a specific value not present in the retrieved material is "bad" even if the value sounds right.

An answer that correctly refuses, or says the information is not present, is "good" when the tool output
indeed does not contain it, and "bad" when the tool output does contain it.

Reply with one line of JSON and nothing else: {"verdict":"good"|"bad","why":"<12 words or fewer>"}`;

const RUBRIC_KEYED = `You are scoring one answer produced by an AI agent working in a code repository.

You see the question, the agent's answer, and the criteria a human wrote for this item.

"accept" lists what must be present. "fail" lists what voids the answer even if the rest is right.
Score "good" only if every accept criterion is satisfied and no fail criterion applies. Wording may
differ from the criteria; the substance must not.

Reply with one line of JSON and nothing else: {"verdict":"good"|"bad","why":"<12 words or fewer>"}`;

function parseVerdict(text: string): { ok: boolean | null; why: string } {
  const m = text.match(/\{[\s\S]*?\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const v = String(j.verdict || "").toLowerCase();
      if (v === "good" || v === "bad") return { ok: v === "good", why: String(j.why || "").slice(0, 120) };
    } catch { /* falls through to the loose read below */ }
  }
  // A judge that ignored the format still usually says the word. Null rather than a guess when it does not,
  // so an unparseable judge abstains instead of voting.
  const t = text.toLowerCase();
  if (/\bgood\b/.test(t) && !/\bbad\b/.test(t)) return { ok: true, why: "loose read" };
  if (/\bbad\b/.test(t) && !/\bgood\b/.test(t)) return { ok: false, why: "loose read" };
  return { ok: null, why: `unparseable: ${text.slice(0, 60)}` };
}

async function askJudge(m: vscode.LanguageModelChat, prompt: string, token?: vscode.CancellationToken): Promise<{ ok: boolean | null; why: string }> {
  try {
    const res = await m.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], { justification: "Judging an assessment answer" }, token ?? new vscode.CancellationTokenSource().token);
    let text = "";
    for await (const p of res.stream) if (p instanceof vscode.LanguageModelTextPart) text += p.value;
    return parseVerdict(text.trim());
  } catch (e: any) {
    return { ok: null, why: `threw: ${String(e?.message || e).slice(0, 80)}` };
  }
}

export async function judgeArtifact(file: string, spec: JudgeSpec, token?: vscode.CancellationToken, say?: (s: string) => void): Promise<string> {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const answers = (d.answers || []) as any[];
  const wrote = (d.model || {}).name || "?";
  const maxResult = spec.maxResult || 6000;

  const all = await vscode.lm.selectChatModels({});
  // Hosted models by default. A pool of box models cannot work: the box holds one model resident at a time, so
  // four judges would mean four loads per item.
  const wanted = spec.judges?.length ? spec.judges : all.filter((m) => m.vendor === "copilot").slice(0, 3).map((m) => m.id);
  // A provider may decorate the name and qualify the id: the box calls GLM-4.7-Flash "GLM-4.7-Flash · box" with
  // id "<url>|GLM-4.7-Flash", so an exact match on either resolved no judge at all and every artifact failed.
  const find = (w: string) => all.find((m) => m.id === w || m.name === w || m.id.endsWith("|" + w) || m.name.startsWith(w + " "));
  const judges = wanted.map(find).filter((m): m is vscode.LanguageModelChat => !!m)
    .filter((m) => spec.selfJudge || m.name !== wrote);
  if (!judges.length) throw new Error(`no judges available; asked for ${wanted.join(", ")}, the editor offers ${all.map((m) => m.id).join(", ")}`);

  const key = spec.key ? JSON.parse(fs.readFileSync(spec.key, "utf8")) : null;
  const order: string[] | null = key?.order || null;

  const rows: any[] = [];
  for (const a of answers) {
    if (token?.isCancellationRequested) break;
    const label = order ? order[a.n - 1] : null;
    const crit = key && label ? key.items[label] : null;
    const shown = (a.callsFull || []).map((c: any) => `[${c.name}] ${String(c.result || "").slice(0, 1200)}`).join("\n\n").slice(0, maxResult);
    const prompt = crit
      ? `${RUBRIC_KEYED}\n\n## Question\n${a.q}\n\n## Criteria\naccept: ${JSON.stringify(crit.accept)}\nfail: ${JSON.stringify(crit.fail || [])}\n\n## Answer\n${(a.answerFull || "(none)").slice(0, 8000)}`
      : `${RUBRIC_BLIND}\n\n## Question\n${a.q}\n\n## Tool output the agent retrieved\n${shown || "(none)"}\n\n## Answer\n${(a.answerFull || "(none)").slice(0, 8000)}`;
    const verdicts: Verdict[] = [];
    for (const j of judges) {
      const v = await askJudge(j, prompt, token);
      verdicts.push({ judge: j.name, ...v });
      say?.(`item ${a.n} ${verdicts.length}/${judges.length} judges`);
    }
    const votes = verdicts.filter((v) => v.ok !== null);
    const good = votes.filter((v) => v.ok).length;
    rows.push({
      n: a.n, item: label,
      pooled: votes.length ? good * 2 > votes.length : null,
      good, votes: votes.length, abstained: verdicts.length - votes.length,
      unanimous: votes.length > 0 && (good === 0 || good === votes.length),
      verdicts,
    });
  }

  const scored = rows.filter((r) => r.pooled !== null);
  const out = {
    judged: { at: new Date().toISOString(), of: path.basename(file), mode: key ? "keyed" : "blind", judges: judges.map((j) => j.name), selfJudge: !!spec.selfJudge, wrote },
    run: d.run, model: d.model,
    score: { good: scored.filter((r) => r.pooled).length, of: scored.length, unscored: rows.length - scored.length, unanimous: scored.filter((r) => r.unanimous).length },
    rows,
  };
  const dest = file.replace(/\.json$/, `.judged-${key ? "keyed" : "blind"}.json`);
  fs.writeFileSync(dest + ".tmp", JSON.stringify(out, null, 1));
  fs.renameSync(dest + ".tmp", dest);
  return dest;
}

export function registerJudge(context: vscode.ExtensionContext) {
  context.subscriptions.push(vscode.commands.registerCommand("sunstone.judge", async (spec?: JudgeSpec) => {
    const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
    let files = spec?.artifacts;
    // Only ask when a person asked. An empty list arriving from a queue used to open a picker that nobody
    // answered, and the pass reported success having judged nothing.
    if (spec && !files?.length) { vscode.window.showErrorMessage("Judging was asked for with no artifacts."); return; }
    if (!files?.length) {
      const dirs = folders.flatMap((r) => [path.join(r, ".sunstone"), path.join(r, "out", "test", "assess")]).filter(fs.existsSync);
      const found = dirs.flatMap((d) => fs.readdirSync(d).filter((f) => f.endsWith(".json") && !f.includes("judged") && !f.includes("queue")).map((f) => path.join(d, f)));
      if (!found.length) { vscode.window.showErrorMessage("No assessment artifacts found to judge."); return; }
      const pick = await vscode.window.showQuickPick(found.map((f) => ({ label: path.basename(f), description: path.dirname(f), f })), { title: "Judge which runs?", canPickMany: true });
      if (!pick?.length) return;
      files = pick.map((p) => p.f);
    }
    const done: string[] = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Judging ${files.length} run(s)`, cancellable: true }, async (progress, token) => {
      for (const f of files!) {
        if (token.isCancellationRequested) break;
        try { done.push(await judgeArtifact(f, spec || {}, token, (s) => progress.report({ message: `${path.basename(f)}: ${s}` }))); }
        catch (e: any) { vscode.window.showErrorMessage(`Judging ${path.basename(f)} failed: ${e?.message || e}`); }
      }
    });
    vscode.window.showInformationMessage(`Judged ${done.length} run(s).`);
  }));
}
