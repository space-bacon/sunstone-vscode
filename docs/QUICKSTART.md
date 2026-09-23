# Quickstart: Black Window in VS Code

Ten minutes from a fresh window to a chat that runs on your own hardware, remembers the folders you point it at, and
cites what it reads.

## 0. What you get

- **Your models in the chat picker.** Every place you add (a rented box, a server of your own, a llama-server on this
  machine) shows its models under the **Black Window** vendor. Pick one and the built-in chat, agent mode included,
  runs on it.
- **The Weave.** Folders you choose are indexed into Black Window's memory (text and code, kept current on save,
  restored between sessions). Any model can search it with `#weave`; `@blackwindow` answers from it with citations.
- **Lookup, digest, memory.** `#lookup` reads Wikipedia, the news desk or the web and cites; `#digest` reads a file
  whole into notes; `#remember` keeps a note across chats.
- **The standalone page.** `Black Window: Open the Standalone Page` opens the full Black Window page beside the editor for when
  you want its own interface.

## 1. Install (development build)

```
git clone https://github.com/space-bacon/sunstone ~/development/sunstone
cd ~/development/sunstone && npm install
./scripts/sync-engine.sh        # needs ~/development/blackwidow with engine/dist built (cd blackwidow/engine && ./stage.sh)
npm run build
```

Open the `sunstone` folder in VS Code and press **F5**. A second window opens with the extension loaded (the
`launch.json` points it at `../blackwidow` as the workspace; open any folder you like instead). After a code change,
F5 again, or `npm run build` and **Developer: Reload Window** in that window.

## 2. Add a place

A place is anything that speaks the OpenAI chat API over http(s): a box from our vast templates, a llama-server or
vLLM you run, LM Studio, Ollama's OpenAI endpoint.

**A box.** The box prints a pairing line once its tunnel is up:
`BLACK WINDOW: open https://blackwindow.xyz/#box=…` (in the instance logs, or `tail -1 /root/pair.log` over ssh).
`cmd+shift+p` → **Sunstone: Add a Place** → paste the line → accept the name. The URL goes to `sunstone.places`, the
key to VS Code's secret store; nothing is written to `settings.json` that you would not commit.

**This machine.** In the **Sunstone → Places** view, *Start llama-server on This Machine*: it scans
`~/Library/Application Support/xyz.blackwindow.app/models`, `~/.cache/llama.cpp` and `~/models` for GGUFs, writes a
router preset and starts `llama-server` on `127.0.0.1:8083` with a generated key, then adds it as the place `local`.
Or run your own and add its URL with **Add a Place**.

The tunnel URL of a box changes when the box restarts. Run **Add a Place** again with the new pairing line; the place
is updated, not duplicated.

## 3. Put Black Window in the model picker

Chat → model picker → **Manage Models…** → **Black Window** → tick the models you want (`GLM-4.7-Flash · box`,
`gpt-oss-20b · box`, `Qwen3.8-27B · box`, `Kimi-K2.6 · box`, `Qwen3.5-9B · local`…). They appear in the picker with the
place name after the model. The one serving now is listed first.

A router box holds one model at a time: picking one that is not serving loads it on first use. Small models take
seconds, a 27B about a minute, gemma-4-31B about a minute, Kimi-K2.6 (544 GB from RAM) about thirty minutes cold.
The Output channel **Black Window** shows the server's own timings for every turn.

If the vendor does not show up, **Sunstone: Refresh Models**.

**When something is longer than the model can read.** Every model takes in a fixed amount at once, and anything past
it used to come back as an error. What does not fit now goes into the weave, and the model is given a tool that
searches it, so it asks for the piece it needs instead of refusing. Nothing to switch on: a file larger than the
window, a long tool result, or a conversation that has run on all keep working, and the Output channel **Black
Window** names what was set aside on each turn. Checked on 2026-09-16 by a run that buries one fact 154,699
characters past the cut and asks for it back; [ADVANCED.md](ADVANCED.md) has the command.

## 4. Weave the folders you care about

Right-click a folder in the Explorer → **Black Window: Weave This Folder**, or `@blackwindow /weave` for the current
workspace folder. Text and code files go in (dependency and build directories skipped, 512 KB per file cap). A
notes folder of ten files is 450 passages in under two seconds; a source folder chunks by definition so a hit reads
as `[places.ts: parsePairing]`.

Saved files are re-woven after 1.5 s. The weave is saved to workspace storage and restored on the next start in one
read (vectors included), so a start is not a re-index. **Black Window: Forget a Woven Folder** removes one.

## 5. Chat

- **Agent mode with your model**: pick `GLM-4.7-Flash · box`, ask as you would; the model calls the built-in tools
  and Black Window's: `#weave` (search the woven folders), `#lookup` (Wikipedia / `where: news` / `where: web`),
  `#digest` (read a file whole), `#remember` (keep a note). Type the `#` name to force one; leave it to the model
  otherwise.
- **`@blackwindow`**: the house voice. Searches the weave first, cites `[n]`, attaches the source files. `/lookup` and
  `/news` read and cite; `/digest <path>` reads a file whole into ordered notes; `/weave` indexes.
- **Black Window: Search the Weave**: a quick pick over passages that opens the file.
- **Ask About the Selection** (`cmd+alt+b`) and **Insert the Last Reply** work with the standalone page.

## 6. Settings that matter

| setting | default | what it is |
|---|---|---|
| `sunstone.places` | `[]` | names and URLs; keys live in the secret store |
| `sunstone.model` | `""` | model the standalone page loads on open |
| `sunstone.digestModel` | `""` | which picker model the digest tool uses (substring); empty = a Custom Endpoint or Black Window model, else the first |
| `sunstone.port` | `47393` | loopback port for the page; keep it stable so caches and settings persist |
| `sunstone.local.*` | | llama-server path, model folders, port (8083), largest context (32768) for *Start llama-server*; each model gets what memory allows after its weights |

## 7. When something is off

- **Models missing from the picker**: is the place up? (`curl -H "Authorization: Bearer KEY" URL/models`.) Then
  **Sunstone: Refresh Models**. A restarted box has a new tunnel URL: re-add.
- **Empty reply from gpt-oss or Kimi**: fixed on our side (reasoning is switched off the way each template wants);
  if you run your own server with a different template, check the Output channel for `reasoning_content`.
- **`#weave` finds nothing**: no folder woven yet, or the Memory view was never shown in this window. **Black Window:
  Weave This Folder** does both.
- **Slow first turn on a model**: it is loading on the box. The picker shows "loads on first use".
- **The window looks full the moment you switch models**: a small model's window is smaller than the history the
  previous one held. With the Memory view up the overflow folds into the weave and the passages nearest the question
  come back, so the percentage is against what the provider accepts rather than what the server holds. The Output
  channel says what was folded and what was recalled.
- **"exceeds the available context size"**: the picker had a window the server did not honour. The provider reads
  `/props` on first use, learns the real window from the server's own refusal and re-advertises it, so sending again
  fits. To keep the whole history instead, give the model a bigger window: `sunstone.local.ctx` and a restart here,
  or `c` for that model in `models.ini` on the box.
- **Everything**: Output → **Black Window** is the page's log plus the extension's; the Memory view's own page is in
  `[weave]` lines.

## 8. The measured numbers behind this

From `docs/M0.md` to `docs/M3.md`, all on 2026-09-12: GLM-4.7-Flash on the box 115 to 135 tok/s, first token under a
second, tool calls parsed on the first try; gpt-oss-20b 184 to 205 tok/s; Kimi-K2.6 8 tok/s after a 30-minute cold
load; Qwen3-0.6B inside the page on WebGPU 71 tok/s; weave up in 3 s on a warm origin, 696 passages restored with
their vectors in 3 s; Wikipedia lookup 0.7 s for four articles.
