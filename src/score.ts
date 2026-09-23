// Scoring a "which file" answer. No vscode import, so the extension, the harness and a plain-node runner
// all use one copy: the SWE-bench arm is scored outside the editor and a second implementation of grepTop
// is how two arms of one comparison come to disagree.

export type GrepFile = { rel: string; text: string };

const STOP = new Set("where which what does when is are the a an of in on for to and or with into from by as at be it its this that function file page does get set run".split(" "));

export function contentWords(q: string): string[] {
  return [...new Set(q.toLowerCase().replace(/[^a-z0-9_@\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

/** A lexical baseline: tf-idf over the query's content words, normalised by document length.
 *  The first version summed `1 + log(tf)` with neither idf nor length normalisation, which makes a long file
 *  win on fewer matched words than a short one. On the 38-item set's own 75 files it answered the largest file
 *  on 37 of 38 items; on SWE-bench it answered jQuery 41 times and sent 243 of 500 answers to paths that are
 *  never a gold. That is a constant, not a baseline. */
export function grepTop(files: GrepFile[], q: string): string {
  const words = contentWords(q);
  if (!words.length || !files.length) return "";
  const tf = files.map((f) => words.map((w) => f.text.split(w).length - 1));
  const idf = words.map((_, j) => Math.log(1 + files.length / (1 + tf.reduce((n, row) => n + (row[j] ? 1 : 0), 0))));
  let best: { rel: string; score: number } | undefined;
  for (let i = 0; i < files.length; i++) {
    let s = 0;
    for (let j = 0; j < words.length; j++) if (tf[i][j]) s += (1 + Math.log(tf[i][j])) * idf[j];
    s /= Math.sqrt(Math.max(files[i].text.length, 1));
    if (s && (!best || s > best.score)) best = { rel: files[i].rel, score: s };
  }
  return best?.rel || "";
}

// The gold file is matched on its whole relative path, not its basename: at five-repo scale index.html and
// README.md exist several times over and a basename match credits the wrong file.
export function isGold(source: string | undefined, gold: string): boolean {
  return !!source && (source === gold || source.endsWith("/" + gold) || source.endsWith("/" + gold.split("/").pop()!) && gold.split("/").length === 1);
}

/** 1-based rank of the first hit matching any gold, or 0 for not in the list. Any of several golds counts,
 *  which is the recall the localization literature reports. */
export function goldRank(hits: { source: string }[], golds: string[]): number {
  for (let i = 0; i < hits.length; i++) if (golds.some((g) => isGold(hits[i].source, g))) return i + 1;
  return 0;
}

export function lineOf(h?: { text: string }): number | null {
  const m = h?.text.match(/@L(\d+)\]/);
  return m ? +m[1] : null;
}
