import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { EXCLUDE } from "./weave";
import type { GrepFile } from "./score";

// The file walk needs vscode; the scoring does not and lives in ./score, so the SWE-bench runner outside the
// editor uses the same copy. Scoring logic in two places has produced two answers here before.
export { grepTop, isGold, goldRank, lineOf, contentWords } from "./score";
export type { GrepFile } from "./score";

export type CodeItem = { id: string; q: string; file: string; symbol: string; line: number; files?: string[]; exclude?: string[]; repo?: string };

/** Every text file under the folders, lowercased, for the grep arm. `rel` is folder-name + relative path,
 *  which is how the store keys a source, so isGold compares like with like. The exclude is the weave's own,
 *  not a shorter one: with five exclusions this searched 46,930 files against the weave's 440, almost all of
 *  it a downloaded VS Code under .vscode-test, and grep's top hit was a VS Code internal on 15 of 38 items.
 *  Two arms of a comparison have to see the same files. */
export async function grepIndex(folders: string[], glob = "**/*.{ts,js,html,py,sh,md,json}"): Promise<GrepFile[]> {
  const files: GrepFile[] = [];
  for (const f of folders) for (const u of await vscode.workspace.findFiles(new vscode.RelativePattern(f, glob), EXCLUDE)) {
    try {
      const st = fs.statSync(u.fsPath); if (st.size > 2_000_000) continue;
      files.push({ rel: path.relative(path.dirname(f), u.fsPath), text: fs.readFileSync(u.fsPath, "utf8").toLowerCase() });
    } catch {}
  }
  return files;
}
