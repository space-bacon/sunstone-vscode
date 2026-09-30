import * as vscode from "vscode";

// Hugging Face's "Use this model" button for Sunstone opens vscode://sunstonenorth.sunstone/hf?model=<repo>[&file=<path>].
// The local llama-server router fetches the GGUF itself (POST /models), so the quant is all this needs from the file.
export interface HubRequest { repo: string; file?: string; spec: string }

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
const QUANT = /(?:^|[-_./])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|F16|BF16|F32))(?:-\d{5}-of-\d{5})?\.gguf$/i;

export function parseHubUri(uri: vscode.Uri): HubRequest {
  const q = new URLSearchParams(uri.query);
  const repo = (q.get("model") || "").trim();
  if (!REPO.test(repo)) throw new Error(`"${repo}" is not a Hugging Face model id`);
  const file = (q.get("file") || "").trim() || undefined;
  if (file && (!/\.gguf$/i.test(file) || file.split("/").some((s) => s === ".." || s === ""))) throw new Error(`"${file}" is not a GGUF file in ${repo}`);
  const quant = file?.match(QUANT)?.[1];
  return { repo, file, spec: quant ? `${repo}:${quant.toUpperCase()}` : repo };
}
