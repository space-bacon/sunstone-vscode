# Sunstone

The Black Window suite inside VS Code. Three things, which you can use separately:

1. **Your own model servers in the editor's model picker.** Anything serving the OpenAI-compatible
   API: a `llama-server` on this machine, a box you rent, a router in front of several.
2. **A memory of the folders you weave.** Indexed on your machine, kept current as you save, and
   searched by whichever model you are using through a tool.
3. **A standalone page.** The whole engine, model and index and reader, in one tab.

Nothing is routed through us. There is no account and no key to give anyone. Keys you add for your
own servers live in the editor's secret store, never in `settings.json`.

---

## Start here: weave a folder

**This is the step people miss.** Nothing is indexed until you say so. A fresh install knows about
no folders, so the tools answer out of an empty store and the models fall back to `grep`.

Run **Black Window: Weave This Folder** from the command palette, or right-click a folder in the
Explorer and choose it, or use the button in the Places view title bar.

What happens:

- Text and source files under the folder are read, split into passages and embedded on your machine.
- The passage index is held in workspace storage. The text itself is not copied anywhere.
- Saving a file re-indexes that file alone, so the store does not drift from the working tree.
- `node_modules`, `.git`, `.venv*`, build output and caches are excluded already. Add your own with
  `sunstone.weave.exclude`.

The status bar shows a passage count once something is woven. Until then it reads "nothing woven
yet", which is the signal that step one has not happened.

To undo: **Black Window: Forget a Woven Folder**.

---

## The five tools

Once a folder is woven, these are offered to whichever model you are chatting with, including the
hosted ones. In a chat you can name them with `#`.

| Tool | What it does |
| --- | --- |
| `#weave` | Semantic search over your woven folders. Returns passages with the file and definition each sits in. |
| `#weaveFolder` | Index another folder without leaving the chat. |
| `#digest` | Read a whole file into ordered notes, then notes of notes, so a long file fits in an answer. |
| `#lookup` | Live lookup with citations: Wikipedia by default, or a news desk. |
| `#remember` | Keep a note across chats: a decision, a fact about the project. |

Two things about search behaviour worth knowing. A search returns at most two passages from any one
source, so a single long document cannot answer a question by itself; name the file and read it
when you need depth in one place. Sources belonging to an open conversation are excluded from an
ordinary search and are never saved.

There is also a chat participant, **@blackwindow**, which answers from the woven folders with
citations.

### Other MCP clients

**Sunstone: Serve the Weave to MCP Clients** lets an agent outside VS Code, such as Claude Code, Cursor or
Claude Desktop on the same machine, search this window's weave. It offers three of the tools, `#weave`, `#lookup`
and `#remember`, under their tool names (`blackwindow_weave_search`, `blackwindow_lookup`,
`blackwindow_remember`), and they answer exactly as they do here, because they are the same tools.

The command copies a client configuration to the clipboard. It runs `node` on a small bridge script Sunstone
writes to its storage, pointed at this window's socket, and it holds no key: the socket sits in a directory only
your user can open, and that is the access control. Paste it under `mcpServers` in the client's configuration,
or take **Copy the Claude Code Command** from the notification for a `claude mcp add` line. The window has to be
open for the client to connect; the socket is named by the workspace, so a client configured once finds the same
window after a restart. Serving stays on across restarts until **Sunstone: Stop Serving the Weave to MCP
Clients**. It needs a Unix socket, so it is not available on Windows yet.

---

## Your own servers in the model picker

Sunstone registers a `blackwindow` provider, so your servers appear in the editor's own model
picker beside the hosted models.

### A server on this machine

**Sunstone: Start llama-server on This Machine.** It looks for `llama-server` on `PATH`, then
`/opt/homebrew/bin` and `/usr/local/bin`; set `sunstone.local.llamaServer` to point somewhere else.
Models are found by scanning for `.gguf` three levels deep under the Black Window app's models
folder, `~/.cache/llama.cpp` and `~/models`, or whatever you put in `sunstone.local.modelDirs`.

It binds to `127.0.0.1` on `sunstone.local.port` (8083) and is keyed. `sunstone.local.ctx` caps the
context window; each model gets what memory allows after its weights.

Stop it with **Sunstone: Stop llama-server**.

### A model from Hugging Face

A link of the form `vscode://sunstonenorth.sunstone/hf?model=<repo>&file=<file.gguf>` opens in Sunstone:
after you confirm, the llama-server on this machine fetches that GGUF from Hugging Face itself and the model
joins the chat model picker, as "<model> · local". It loads on first use. The server starts if it was not
running, even with no model on disk yet. The file is fetched into Sunstone's storage rather than into your
model folders, and `file` only chooses the quant: `...-Q4_K_M.gguf` fetches `<repo>:Q4_K_M`, and a link
without it takes llama.cpp's default. A repository that needs a login on the Hub cannot be fetched this way.

### A box elsewhere

**Sunstone: Add a Place.** Paste the pairing line the box printed, or just its URL. The key goes to
the editor's secret store under `sunstone.key:<url>`, not to `settings.json`, so it does not sync
and does not land in a dotfile.

Sunstone probes each place, lists the models it serves and shows which are loaded. **Load on the
Server** loads one from the tree. **Sunstone: Add a Model to a Box** pulls a new one down.

If a model does not appear in the picker after a change, **Sunstone: Refresh Models in the Chat
Picker**.

### What the provider does for you

- **Tool calling** is enabled for every model, and image input for models whose id says they have
  vision.
- **A window that is too small is folded rather than hit.** When a conversation outgrows what the
  model can hold, the older turns and the longest tool results move into the store and come back
  when they are the closest match to the question, so what leaves the window is the least relevant
  part rather than simply the oldest. The model is given a recall tool to search what was folded.
- Reasoning is switched off for models that emit it in a form the editor would show raw.

---

## The standalone page

**Black Window: Open the Standalone Page** serves the whole engine on `127.0.0.1` at
`sunstone.port` (47393). Keep that port stable: the page's caches of model weights belong to that
origin, and changing it throws them away.

**Black Window: Load a Model in the Standalone Page** picks what it runs. It keeps working offline.

---

## Working in the editor

- **Sunstone: Ask About the Selection.** Select code, ask about it without leaving the file.
- **Sunstone: Insert the Last Reply.** Puts the previous answer at the cursor.
- **Black Window: Search the Weave.** Search the store directly, without a model in the way.

### Packs

**Black Window: Save a Weave Pack** writes a woven folder out as one file. **Open a Weave Pack**
reads one back. This is how a store moves between machines, or how you hand someone a searchable
copy of a repository without handing them the repository.

---

## Measuring it

These are the tools the published figures come from, and you can run them on your own material.

- **Generate a retrieval set from this repository** builds questions from your own files.
- **Run the assessment** runs a model against a question set, with or without the store, and writes
  one JSON line per item as it goes.
- **Judge assessment runs** scores the output.

Runs are written under `.sunstone/` in the workspace. Exclude that folder from the weave; indexing
your own results puts the answers in the store the run is meant to be testing.

---

## Settings

| Setting | Default | What it is |
| --- | --- | --- |
| `sunstone.places` | `[]` | Your servers. Keys are not here; they are in the secret store. |
| `sunstone.model` | `""` | Model to load when the chat opens. |
| `sunstone.port` | `47393` | Loopback port for the standalone page. Keep it stable. |
| `sunstone.weave.exclude` | `[]` | Globs kept out of the weave, on top of the built-in list. |
| `sunstone.local.llamaServer` | `""` | Path to `llama-server`. Empty means search `PATH`. |
| `sunstone.local.modelDirs` | `[]` | Where to scan for `.gguf` files. |
| `sunstone.local.port` | `8083` | Port for the local `llama-server`. |
| `sunstone.local.ctx` | `32768` | Largest context window a local model may take. |
| `sunstone.digestModel` | `""` | Model the digest tool uses. Empty picks a custom endpoint if there is one. |
| `sunstone.mcp.serve` | `false` | Serve each window's weave to MCP clients outside VS Code. Set by **Sunstone: Serve the Weave to MCP Clients**. |

---

## When something is wrong

**The tools answer with nothing.** Check the status bar. If it does not show a passage count,
no folder is woven; that is the first step above.

**A model is missing from the picker.** Run **Sunstone: Refresh Models in the Chat Picker**. If it
is still missing, **Sunstone: Refresh Places** and check the place is answering.

**The local server will not start.** `llama-server` is probably not installed. On macOS,
`brew install llama.cpp`. The Places view says which of the three cases it found.

**A long prompt is refused.** It should not be; the provider folds what does not fit. If you see a
truncation error, the Output channel under **Black Window** says what it did.

**The page lost its cached weights.** `sunstone.port` changed. Put it back.

The **Black Window** output channel carries the detail for all of the above.

---

## What leaves your machine

The index, the passages and the text stay local. The standalone page and the local server bind to
`127.0.0.1`. The MCP endpoint, when you turn it on, is a Unix socket in a directory only your user can
open, not a port. The extension host contains no non-loopback URL.

Two deliberate exceptions, both of which you invoke by name:

- `#lookup` fetches from Wikipedia or a news source, because that is what it is for.
- A place you add is a server you chose. If it is someone else's box, your prompts go to it.

A hosted model you pick in the editor's picker is between you and that vendor as usual. Sunstone
does not add itself to that path.
