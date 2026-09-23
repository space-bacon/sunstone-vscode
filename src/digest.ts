import * as vscode from "vscode";
import * as path from "path";
import { Weave } from "./weave";

// Read a file whole into notes with a chat model from the picker: the page's digest, done here because the weave
// page runs without a chat model. One note per part (parts cut at paragraph or blank-line boundaries), then, while the
// notes together outgrow a window's worth, a pass of notes over the notes. The notes go into the weave under
// digest:<source> so a later question finds them, and the finest level comes back to the caller.

const PART_CHARS = 6000, JOINED_CAP = 6000;

const NOTE = "Read the passage below, one part of a longer document, and write one note on it: what it covers, the concrete facts, figures, names and decisions in it, and anything it claims or concludes. Write in full sentences, four to eight of them, in your own words; no preamble, no heading, no bullet list, nothing about the task itself.";
const NOTES_OF_NOTES = "Below are notes on consecutive parts of one document, in order. Write fewer, shorter notes that keep every concrete fact, figure, name and decision, merging neighbours that belong together. One paragraph per note, separated by a blank line; no preamble, no headings.";

export function splitParts(text: string, target = PART_CHARS): string[] {
  const paras = text.replace(/\r/g, "").split(/\n{2,}/);
  const parts: string[] = []; let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > target) { parts.push(cur); cur = ""; }
    if (p.length > target * 1.5) { for (let i = 0; i < p.length; i += target) parts.push(p.slice(i, i + target)); continue; }
    cur = cur ? cur + "\n\n" + p : p;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

export async function pickModel(): Promise<vscode.LanguageModelChat | undefined> {
  const want = (vscode.workspace.getConfiguration("sunstone").get<string>("digestModel") || "").toLowerCase();
  const all = await vscode.lm.selectChatModels();
  if (!all.length) return undefined;
  if (want) { const m = all.find((x) => [x.id, x.name, x.family, x.vendor].some((s) => String(s).toLowerCase().includes(want))); if (m) return m; }
  return all.find((m) => m.vendor === "customendpoint") || all[0];
}

async function ask(model: vscode.LanguageModelChat, instruction: string, body: string, token: vscode.CancellationToken): Promise<string> {
  const res = await model.sendRequest([vscode.LanguageModelChatMessage.User(`${instruction}\n\n---\n\n${body}`)], {}, token);
  let out = "";
  for await (const part of res.stream) if (part instanceof vscode.LanguageModelTextPart) out += part.value;
  return out.replace(/<think>[\s\S]*?<\/think>\s*/g, "").trim();
}

export interface Digest { source: string; parts: number; levels: number; notes: string[]; model: string; secs: number }

export async function digestFile(weave: Weave, uri: vscode.Uri, model: vscode.LanguageModelChat, token: vscode.CancellationToken, progress?: (msg: string) => void): Promise<Digest> {
  const t0 = Date.now();
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = Buffer.from(bytes).toString("utf8");
  const folder = weave.folders.find((f) => uri.fsPath.startsWith(f + path.sep));
  const source = folder ? weave.sourceName(folder, uri.fsPath) : path.basename(uri.fsPath);
  const parts = splitParts(text);
  let notes: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (token.isCancellationRequested) break;
    progress?.(`pass 1: note ${i + 1} of ${parts.length}`);
    const n = await ask(model, NOTE, parts[i], token);
    if (n) notes.push(n);
  }
  let levels = 1;
  const all: string[][] = [notes];
  while (notes.join("\n\n").length > JOINED_CAP && notes.length > 2 && !token.isCancellationRequested) {
    levels++;
    progress?.(`pass ${levels}: notes of the ${notes.length} part notes`);
    const groups = splitParts(notes.join("\n\n"), JOINED_CAP);
    const next: string[] = [];
    for (const g of groups) { const r = await ask(model, NOTES_OF_NOTES, g, token); next.push(...r.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)); }
    if (next.length >= notes.length) break;
    notes = next; all.push(notes);
  }
  // Every level is searchable; the finest goes back to the caller.
  await weave.ensure();
  for (let l = 0; l < all.length; l++) {
    const name = `digest:${source}${l ? `~${l + 1}` : ""}`;
    await weave.host.bw("unindex", [name], 30_000).catch(() => 0);
    await weave.host.bw("index", [name, all[l].join("\n\n"), "text"], 120_000).catch(() => 0);
    weave.markDirty(name);
  }
  weave.scheduleSave();
  return { source, parts: parts.length, levels, notes, model: model.name, secs: Math.round((Date.now() - t0) / 100) / 100 };
}
