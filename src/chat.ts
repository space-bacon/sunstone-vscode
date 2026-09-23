import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { Weave, Hit } from "./weave";
import { digestFile, pickModel } from "./digest";

// Black Window inside VS Code's own chat: tools any model can call in agent mode (`#weave`, `#lookup`, `#digest`,
// `#remember`), and the @blackwindow participant, which answers from the weave in the house voice with whatever model
// the picker has, looks things up on request, and keeps its turns as memory for later chats.

const HOUSE = "You are a concise, capable assistant. Write in full sentences and lead with the fact. Avoid em dashes. Do not announce that something is important or worth noting; state it. Notes retrieved for this message follow; use them when they answer the question and cite them as [n], otherwise answer from what you know and say so.";

function formatHits(hits: Hit[]): string {
  // A code passage's label carries its first line (@L12): shown as file:line so the agent can open exactly there.
  return hits.map((h, i) => { const m = h.text.match(/^\[[^\]]*@L(\d+)\]/); return `[${i + 1}] ${h.source}${m ? `:${m[1]}` : ""} (score ${h.score.toFixed(2)})\n${h.text.slice(0, 2400)}`; }).join("\n\n");
}

// A weave result labels its source `<folder>/path/to/file` and a model hands that label straight back, but a woven
// folder is not always a workspace folder, so joining only against the workspace missed every one of them: measured
// on gpt-6-astra, 9 digest calls over 3 items all answered "No file at <folder>/..." while the harness's own
// read_file resolved the same paths. Try the woven roots by leading folder name first, as the weave labels them.
function resolveFile(spec: string, roots: string[] = []): vscode.Uri | undefined {
  spec = String(spec || "").trim(); if (!spec) return vscode.window.activeTextEditor?.document.uri;
  if (path.isAbsolute(spec)) return vscode.Uri.file(spec);
  const at = (p: string) => { try { fs.statSync(p); return vscode.Uri.file(p); } catch { return undefined; } };
  for (const r of roots) {
    const base = path.basename(r);
    if (spec === base) return at(r);
    if (spec.startsWith(base + "/")) { const u = at(path.join(r, spec.slice(base.length + 1))); if (u) return u; }
  }
  for (const w of vscode.workspace.workspaceFolders || []) { const u = at(path.join(w.uri.fsPath, spec)); if (u) return u; }
  for (const r of roots) { const u = at(path.join(r, spec)); if (u) return u; }
  return undefined;
}

// Told plainly it may report a defect or ask which reading is meant, the model did neither in 60 item-runs, and
// on a source that provably lacks the answer it declined 0 of 6 times and confabulated instead. So the tool can
// read the top two sources itself and state the verdict. Offline that comparison was correct 15 of 15 where a
// model judging it got 11 of 15. Live it made things worse: 4.33 of 20 against 7.00 for the same agent without
// it, gap/sd -2.11, and the wrong-answer count rose 5.67 to 8.33 while silence stayed flat, so it manufactured
// confident errors rather than routed questions. Wall clock per unscoped search went 7.2 s to 14.2 s, which is
// how we know it ran. Off unless asked for. The untested suspect is the agree branch firing on one shared token
// that is not the answer, which would assert agreement and invite a confident wrong answer; settling that needs
// a run that records the verdict, because the harness stores tool arguments and not tool results.
const VALUE = /\d+(?:[.,]\d+)*(?:\s*\/\s*\d+)?|[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)+|\b[A-Z][A-Z0-9_]{2,}\b/g;
const valuesIn = (s: string) => new Set((s.match(VALUE) || []).map((x) => x.replace(/\s+/g, "").toLowerCase()));

async function readOne(weave: Weave, model: vscode.LanguageModelChat, query: string, source: string, token: vscode.CancellationToken): Promise<string> {
  const hits = await weave.search(query, 8, [source], "all", undefined, 8).catch(() => []);
  if (!hits.length) return "";
  const body = hits.map((h, i) => `[${i + 1}] ${h.text.slice(0, 1200)}`).join("\n\n");
  const msg = [vscode.LanguageModelChatMessage.User(`Passages from ${source}:\n${body}\n\nQuestion: ${query}\n\nReply with one line only: the answer from these passages as briefly as possible, or NONE if they do not contain it.`)];
  let out = "";
  try { const r = await model.sendRequest(msg, {}, token); for await (const t of r.text) out += t; } catch { return ""; }
  return (out.split("\n").map((x) => x.trim()).filter(Boolean)[0] || "").replace(/^ANSWER:\s*/i, "").slice(0, 170);
}

async function crossCheck(weave: Weave, query: string, sources: string[], token: vscode.CancellationToken): Promise<string> {
  const model = await pickModel();
  if (!model) return "";
  const said = [] as { source: string; answer: string }[];
  for (const s of sources) said.push({ source: s, answer: await readOne(weave, model, query, s, token) });
  const empty = said.filter((x) => !x.answer || /^none\b/i.test(x.answer));
  if (empty.length === said.length) {
    return `\n\nChecked both sources directly. Neither ${said.map((x) => x.source).join(" nor ")} answers this. Do not assemble an answer out of them. Say it is not in these sources, name the check that would settle it, and ask which file should hold it if you cannot tell.`;
  }
  if (empty.length) {
    const has = said.find((x) => !empty.includes(x))!;
    // Endorsing the survivor looked like the regression: this branch fires 8 of 18 on the model's own queries and
    // its answer is right 3 of 8. Removing the endorsement did not help. Correct went 4.33 to 4.67 of 20 against
    // 7.00 without the check at all, and wrong rose 8.33 to 8.67. Advice to withhold does not land on this model;
    // what lands is advice to act. A tool that must stop it answering has to withhold the material, not warn.
    return `\n\nChecked both sources directly. ${empty[0].source} has nothing on this; only ${has.source} offers "${has.answer}", and nothing corroborates it. Treat it as unconfirmed: read a third source before stating it, or give it with the caveat that one source carries it and the other is silent. Do not present it as settled.`;
  }
  const [a, b] = said;
  const va = valuesIn(a.answer), vb = valuesIn(b.answer);
  if (va.size && vb.size && ![...va].some((t) => vb.has(t))) {
    return `\n\nChecked both sources directly and they DISAGREE. ${a.source} gives "${a.answer}". ${b.source} gives "${b.answer}". Report the disagreement with both figures and their sources rather than choosing between them, say which question each one is answering if they differ, and ask which is meant if the passages cannot settle it.`;
  }
  return `\n\nChecked both sources directly and they agree: ${a.source} and ${b.source} both give "${a.answer}". Answer and cite both.`;
}

// Withholding rather than advising. On the eight locate items the answer is in the top 8 for 7 of them, yet the
// agent is correct on 46% of item-runs and exhausts its 14 rounds on another 46%: it keeps searching while already
// holding the answer. Telling it to stop is the category of instruction this model ignores, so the tool stops
// handing back material it has already handed back. Keyed on the query's content words and on the source set, so
// a genuinely new question is unaffected and only a repeat is refused.
const recentSearches: { at: number; sig: string; sources: string }[] = [];
const querySig = (q: string) => (q.toLowerCase().match(/[a-z0-9]{3,}/g) || []).sort().join(" ");

export function registerChat(context: vscode.ExtensionContext, weave: Weave, out: vscode.OutputChannel): void {
  context.subscriptions.push(vscode.lm.registerTool("blackwindow_weave_search", {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ query: string; k?: number; kind?: string; source?: string }>, token) {
      const { query, k, kind, source } = options.input;
      // Default "auto", not "all": unscoped over a five-repo store, guessing the kind from the question doubled
      // file@1 (9 of 38 to 18 of 38, bench/results/2026-09-13_code_5repo_kind-{all,auto}.json).
      const want = kind === "text" || kind === "code" || kind === "all" ? kind : "auto";
      // Reading one source instead of re-asking the store. Measured on six locate items: the top 8 across all
      // sources answered 2, up to 8 passages from the one source that holds it answered 5. Both distractors seen
      // so far sit inside the right document, one in the same sentence as the answer and one a table row above,
      // so what fixes them is more of that document, not fewer of the others. Without this the only move left
      // after a hit that names the file is another whole-store query, which is the alternation the guards annotate.
      // formatHits labels a code passage `source:line`, so the argument arrives with the line still on it.
      const want_src = String(source || "").trim().replace(/:\d+$/, "");
      // Bring the store up before listing sources. Without this the first scoped search of a session asks a
      // page that is not open yet, the call throws, and the catch reported it as "no woven source matches":
      // a transport failure dressed as an answer about the name. Measured 2026-09-21, the model's first search
      // scoped to ledger/claims.md was refused that way while the file was woven the whole time.
      let all_src: string[] | null = null;
      if (want_src) {
        try {
          await weave.ensure();
          all_src = (await weave.host.bw<{ source: string }[]>("sources", [])).map((s) => s.source);
        } catch { all_src = null; }
      }
      // Most specific tier that matches, so a bare "weave.ts" does not also drag in test/weave.ts and a loose
      // fragment cannot quietly match half the store and narrow nothing.
      const only = !want_src || !all_src ? [] : [
        all_src.filter((s) => s === want_src),
        all_src.filter((s) => s.endsWith("/" + want_src)),
        all_src.filter((s) => s.includes(want_src)),
      ].find((t) => t.length) || [];
      if (want_src && all_src && !only.length) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`No woven source matches "${want_src}". Give it exactly as a result above labels it, or drop the argument to search every source.`)]);
      }
      // A fragment that matches half the store narrows nothing while looking like it worked.
      if (only.length > 5) {
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`"${want_src}" matches ${only.length} woven sources, so it does not narrow anything. Give one source exactly as a result above labels it, for example ${only.slice(0, 3).join(", ")}.`)]);
      }
      const hits = await weave.search(String(query || ""), Math.min(Math.max(+(k || 8), 1), 24), only.length ? only : undefined, want, undefined, only.length ? 8 : undefined);
      if (process.env.SUNSTONE_BUDGET === "1" && !want_src && hits.length) {
        const now = Date.now();
        while (recentSearches.length && now - recentSearches[0].at > 120_000) recentSearches.shift();
        const sig = querySig(String(query || "")), srcs = [...new Set(hits.map((h) => h.source))].sort().join("|");
        const repeat = recentSearches.some((r) => r.sig === sig) || recentSearches.filter((r) => r.sources === srcs).length >= 2;
        recentSearches.push({ at: now, sig, sources: srcs });
        if (repeat) {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`You have already been given these passages, from ${[...new Set(hits.map((h) => h.source))].slice(0, 3).join(", ")}. They are not repeated. Answer from what you have, or open one of those files with read_file, or say what is missing and which file should hold it.`)]);
        }
      }
      const text = hits.length ? formatHits(hits) : want_src && only.length
        ? `Nothing in ${only[0]} matches "${query}". Search without the source argument, or read the file.`
        : `Nothing in the weave matches "${query}". Woven folders: ${weave.folders.join(", ") || "none (run Black Window: Weave This Folder)"}.`;
      // A requested scope that could not be resolved is said out loud. Returning unscoped hits under a scoped
      // request reads to the model as "this is what that file holds", which is how a wrong source becomes a
      // confident answer.
      const unscoped = want_src && !all_src
        ? `The weave could not be reached to resolve the source "${want_src}", so these passages are from every source rather than that one.\n\n`
        : "";
      // Only on an unscoped search: a scoped one is the model already committing to a source.
      const spread = want_src ? [] : [...new Set(hits.map((h) => h.source))];
      const verdict = process.env.SUNSTONE_CROSSCHECK !== "1" || spread.length < 2 ? "" : await crossCheck(weave, String(query || ""), spread.slice(0, 2), token).catch(() => "");
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(unscoped + text + verdict)]);
    },
    prepareInvocation: async (o) => ({ invocationMessage: o.input.source ? `Searching ${String(o.input.source).split("/").pop()} for "${String(o.input.query || "").slice(0, 40)}"` : `Searching the weave for "${String(o.input.query || "").slice(0, 60)}"` }),
  }));

  context.subscriptions.push(vscode.lm.registerTool("blackwindow_weave_folder", {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ folder?: string }>) {
      const folders = vscode.workspace.workspaceFolders || [];
      const want = String(options.input.folder || "");
      const f = want ? folders.find((w) => w.name === want || w.uri.fsPath === want || w.uri.fsPath.endsWith("/" + want)) : folders[0];
      if (!f) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`No workspace folder ${want ? `named ${want}` : "is open"}. Open folders: ${folders.map((w) => w.name).join(", ") || "none"}.`)]);
      // A folder already woven stays current on save, so re-weaving it is a walk of every file for no new passage.
      // Item 5 of the 2026-09-17 assessment answered four searches with seven of these and spent 1,332 seconds on
      // them; a model that cannot find something reaches for this tool, and the honest reply is that the material
      // is already there and the search is where to look.
      if (weave.folders.includes(f.uri.fsPath)) {
        const n = weave.counts.get(f.uri.fsPath) || 0;
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`${f.name} is already woven${n ? `, ${n.toLocaleString()} passages` : ""}, and it stays current on save, so there is nothing to re-weave. If a search is not finding something in it, the material is in the weave and the query is what to change; searching for the words the answer would be written in works better than the words of the question.`)]);
      }
      const r = await weave.indexFolder(f.uri);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`Wove ${f.name}: ${r.files} files, ${r.passages.toLocaleString()} passages. It is searchable now and stays current on save.`)]);
    },
    prepareInvocation: async (o) => ({ invocationMessage: `Weaving ${o.input.folder || "the workspace folder"}`, confirmationMessages: { title: "Weave a folder", message: new vscode.MarkdownString(`Index ${o.input.folder || "the first workspace folder"} into Black Window's memory? Text files only, kept on this machine.`) } }),
  }));

  context.subscriptions.push(vscode.lm.registerTool("blackwindow_lookup", {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ query: string; where?: string; k?: number }>) {
      const { query, where, k } = options.input;
      const kind = where === "news" ? "news" : where === "web" ? "web" : "wiki";
      const r = await weave.lookup(String(query || ""), kind, Math.min(Math.max(+(k || 8), 1), 16));
      const head = r.read?.length ? `Read from ${r.where}: ${r.read.join(", ")}.` : `Nothing usable came back from ${r.where || kind}${r.error ? ` (${r.error})` : ""}.`;
      const lead = r.lead?.length ? `\n\nOpening of the best article:\n${r.lead.join(" ")}` : "";
      const digest = r.digest?.length ? `\n\nThe desk's items:\n${r.digest.slice(0, 12).map((d: any) => typeof d === "string" ? d : d.text || JSON.stringify(d)).join("\n")}` : "";
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`${head}${lead}${digest}${r.hits.length ? `\n\nPassages nearest the question:\n${formatHits(r.hits)}` : ""}`)]);
    },
    prepareInvocation: async (o) => ({ invocationMessage: `Looking up "${String(o.input.query || "").slice(0, 60)}" on ${o.input.where === "news" ? "the news desk" : o.input.where === "web" ? "the web" : "Wikipedia"}` }),
  }));

  context.subscriptions.push(vscode.lm.registerTool("blackwindow_digest", {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ path: string }>, token) {
      const u = resolveFile(options.input.path, weave.folders);
      if (!u) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`No file at ${options.input.path}.`)]);
      const model = await pickModel();
      if (!model) return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart("No chat model is available to read with.")]);
      const d = await digestFile(weave, u, model, token);
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`${d.source}: read whole in ${d.secs} s with ${d.model}, ${d.parts} part${d.parts === 1 ? "" : "s"}, ${d.levels} pass${d.levels === 1 ? "" : "es"}. Notes, in order:\n\n${d.notes.map((n, i) => `[${i + 1}] ${n}`).join("\n\n")}`)]);
    },
    prepareInvocation: async (o) => ({ invocationMessage: `Reading ${o.input.path || "the active file"} whole`, confirmationMessages: { title: "Read a file whole", message: new vscode.MarkdownString(`Send ${o.input.path || "the active file"} through the digest model part by part? Long files take a while.`) } }),
  }));

  context.subscriptions.push(vscode.lm.registerTool("blackwindow_remember", {
    async invoke(options: vscode.LanguageModelToolInvocationOptions<{ text: string; label?: string }>) {
      const n = await weave.remember(String(options.input.text || ""), String(options.input.label || ""));
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(n ? `Kept (${n} passage${n === 1 ? "" : "s"}); a later chat finds it through the weave.` : "Nothing to keep.")]);
    },
    prepareInvocation: async (o) => ({ invocationMessage: `Remembering ${String(o.input.label || o.input.text || "").slice(0, 50)}` }),
  }));

  const participant = vscode.chat.createChatParticipant("sunstone.blackwindow", async (request, chatContext, response, token) => {
    const prompt = request.prompt.trim();
    if (!prompt && !request.command) { response.markdown("Ask something; I answer from the woven folders first. `/weave` indexes the current workspace folder, `/lookup` and `/news` read Wikipedia or the news desk, `/digest` reads a file whole."); return; }
    if (request.command === "weave") {
      const folders = vscode.workspace.workspaceFolders || [];
      if (!folders.length) { response.markdown("No workspace folder is open."); return; }
      const f = folders.find((w) => w.name === prompt) || folders[0];
      response.progress(`weaving ${f.name}`);
      const r = await weave.indexFolder(f.uri);
      response.markdown(`Wove **${f.name}**: ${r.files} files, ${r.passages.toLocaleString()} passages. Searchable now; kept current on save.`);
      return;
    }
    if (request.command === "digest") {
      const u = resolveFile(prompt, weave.folders);
      if (!u) { response.markdown(`No file at ${prompt || "(none open)"}.`); return; }
      const model = request.model || (await pickModel());
      if (!model) { response.markdown("No chat model is selected."); return; }
      const d = await digestFile(weave, u, model, token, (m) => response.progress(m));
      response.markdown(`**${d.source}**: read whole in ${d.secs} s with ${d.model}, ${d.parts} part${d.parts === 1 ? "" : "s"}, ${d.levels} pass${d.levels === 1 ? "" : "es"}.\n\n${d.notes.map((n, i) => `${i + 1}. ${n}`).join("\n\n")}`);
      response.reference(u);
      return;
    }
    let hits: Hit[] = [];
    let read = "";
    if (request.command === "lookup" || request.command === "news") {
      const kind = request.command === "news" ? "news" : "wiki";
      response.progress(`reading ${kind === "news" ? "the news desk" : "Wikipedia"}`);
      try { const r = await weave.lookup(prompt, kind, 8); hits = r.hits; read = r.read?.length ? `read ${r.read.join(", ")}` : `nothing usable from ${r.where || kind}`; if (r.lead?.length) hits.unshift({ key: "lead", source: `${r.read[0] || "article"} (opening)`, score: 1, text: r.lead.join(" ") }); }
      catch (e: any) { out.appendLine(`@blackwindow ${request.command}: ${e.message || e}`); }
    } else {
      try { response.progress("searching the weave"); hits = await weave.search(prompt, 8); } catch (e: any) { out.appendLine(`@blackwindow: ${e.message || e}`); }
    }
    for (const h of hits) { const u = weave.fileOf(h.source); if (u) response.reference(u); }
    const history: vscode.LanguageModelChatMessage[] = [];
    for (const t of chatContext.history.slice(-6)) {
      if (t instanceof vscode.ChatRequestTurn) history.push(vscode.LanguageModelChatMessage.User(t.prompt));
      else if (t instanceof vscode.ChatResponseTurn) { const text = t.response.map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : "")).join(""); if (text) history.push(vscode.LanguageModelChatMessage.Assistant(text)); }
    }
    // The constant head first, the turn's notes with the question: the same prefix discipline the page keeps for a server's prompt cache.
    const brief = hits.length ? `Notes retrieved for this message:\n\n${formatHits(hits)}\n\n---\n\n${prompt}` : prompt;
    const messages = [vscode.LanguageModelChatMessage.User(HOUSE), ...history, vscode.LanguageModelChatMessage.User(brief)];
    const model = request.model;
    if (!model) { response.markdown("No chat model is selected. Pick one in the model picker (a Custom Endpoint for a box or a local llama-server works)."); return; }
    const res = await model.sendRequest(messages, {}, token);
    let reply = "";
    for await (const part of res.stream) {
      if (part instanceof vscode.LanguageModelTextPart) { response.markdown(part.value); reply += part.value; }
    }
    if (hits.length) response.markdown(`\n\n<sub>${read ? read + " \u00b7 " : ""}${hits.length} notes: ${[...new Set(hits.map((h) => h.source))].slice(0, 6).join(", ")}</sub>`);
    // The turn goes into memory so a later chat can recall it ("what did we settle about X last week").
    if (reply.trim()) weave.remember(`Q: ${prompt}\nA: ${reply.trim()}`, "chat").catch(() => 0);
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "resources", "sunstone-mark.svg");
  context.subscriptions.push(participant);
}
