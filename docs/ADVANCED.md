# Advanced: coding with Black Window as the model and the memory

What the new capability is, in one sentence: the editor's agent now runs on models we control, with a memory we
control, over folders we choose. This note is about using that well for code, and about what we can put to work
today without building anything more.

## 1. What changed for coding

Before: the agent's model was a vendor's, its context was whatever `@workspace` and file reads brought in, and
nothing it learned outlived the chat.

Now:

- **The model is a place we run.** GLM-4.7-Flash at 130 tok/s on a 24 GB card for two dollars an hour; gpt-oss-20b at
  200 tok/s; Kimi-K2.6 (1 T parameters, 32 B active) from a 1 TB RAM box at 8 tok/s; a 9B on the laptop. One picker,
  no vendor quota, no data leaving machines we hold keys to.
- **The prompt cache is ours.** llama-server keeps the KV of the prompt prefix. The page's discipline (constant head,
  per-turn material at the end) carries over to the provider: a long agent session re-reads only what changed.
- **The weave is retrieval we tuned.** bge-small on WebGPU, centred rows, a lexical index beside the dense one, code
  chunked by definition and labelled, prose chunked by section. It answers "where is X handled" for a repo the way the
  page answers it for a paper, and it persists.
- **The tools are ours to shape.** A tool is forty lines and a manifest entry. Anything the suite can do (lookup,
  digest, memory today; the box router, the bench harnesses, the gateway tomorrow) becomes a verb the agent can use.

## 2. Considerations, by the numbers

**Context.** The window is measured, not assumed. `src/gguf.ts` and `box_preset.py` read the GGUF header for
`block_count`, `head_count_kv`, `key_length` and `value_length`, so a model's cache costs
$2 \cdot L \cdot H_{kv} \cdot (d_k + d_v)$ bytes a token and its window is whatever memory is left after its weights,
against VRAM when it fits the card and against RAM when it runs under `fit`, capped by the trained length and by a
24 GB ceiling on the cache itself. That ceiling exists because 631 GB of free RAM would otherwise buy gemma-4-31B a
131K window costing 258 GB of KV. The spread this reveals is wide: GLM-4.7-Flash has 47 layers and one KV head, so
99.9 KB a token, where gemma-4-31B costs 1,920 KB a token. On the 24 GB box that is 131,072 for the first and 8,192
for the second, both of which the old 12 GB size threshold pinned at 16,384.

Measured on the box on 2026-09-16, GLM-4.7-Flash from 16,384 to 131,072: generation 124.4 to 105.9 tok/s, prompt
3,052.5 to 1,887.9 tok/s, VRAM 18,568 to 23,066 of 24,576 MiB. Eight times the window for 15 % of the decode rate. A
29,030-token prompt ran at 1,252 tok/s prompt and 85.3 tok/s generation.

**When the window is still too small.** VS Code budgets the messages and not the tool schemas, which the server
counts: 88 schemas measured 37,934 tokens, over twice a 16K window, which is how a 24,576-token budget arrived as a
36,721-token request. The provider now handles all three parts through the weave. Tools are woven under `tool:<name>`
and the turn's question keeps the ones that fit 40 % of the window. A tool result longer than 25 % of the window
keeps its head and the rest is folded. Turns that do not fit are folded under `chat:<id>/turns` and the passages
nearest the question come back with the question, so the cacheable prefix stays byte-identical. The model gets a
`bw_recall` tool the provider answers itself, up to four rounds that never reach VS Code, withheld on the last one so
a model that answers every turn by reaching for more still has to produce something, and offered even when the turn
brings no tools of its own, which is the case that had no way back to the fold at all. A turn that ends with no text and
no tool call is raised as an error rather than returned empty, which is what a failed conversation summary looks like
from the editor. `chat:` and `tool:` sources are resident only: never written to the store, never in an ordinary
`#weave` search. With the weave up the picker advertises four times the server's window, because the provider absorbs
the overflow. The Output channel reports the whole chain, for example `3 results shortened, 240K folded · 12 of 88
tools by the weave · 14 turns dropped, 62 passages folded, 8 recalled`.

**Checking those paths.** The pairing line carries the box's key, so it goes into a variable and never onto a command
line: `pair.log` gains one line per tunnel restart and the last is the live one.

```
cd ~/development/sunstone
PAIR=$(ssh your-box 'grep "BLACK WINDOW" /root/pair.log | tail -1')
SUNSTONE_PAIR="$PAIR" SUNSTONE_PICK=GLM-4.7-Flash npm run provider
```

Results land in `out/test/provider.json`. Past the models, answer and tool-call legs the run drives both overflow
paths under real pressure: a 463,780-character tool result whose one fact sits at character 246,859, against a
92,160-character cut, so `fold.found` is true only if the fold and `bw_recall` both worked; and 151 tool schemas
costing 69,613 tokens against the 49,152-token share, with the tool the question needs placed last, past the 106 that
fit, so `select.kept` is true only if selection ranked it. An ordinary
turn tests neither, because a 131,072-token window swallows both: the 88 agent schemas fit the share with 11,218
tokens to spare, and this repository's README is 2,635 bytes, 35 times under the cut. Measured 2026-09-16 on
GLM-4.7-Flash: the fold returned the fact verbatim from character 246,859 in 32.1 s. The selection passed on the same
run with the tool at position 75, which does not separate ranking from declaration order because 75 is inside the 106
that fit; it was moved to last afterwards and that arm is unmeasured until the next run.

**Running the agent assessment unattended.** `npm run assess` opens a separate VS Code with its own user-data dir,
pairs the box, weaves the folders it will answer from, and runs the item set one conversation per item, with the model
driving four real tools: `weave_search` against the live store, `read_file`, `list_dir` and `run_command`. Answers,
every tool call and the provider's per-turn accounting go to `out/test/assess.json`.

```
SUNSTONE_PAIR="$PAIR" SUNSTONE_ONLY=14 npm run assess
```

`SUNSTONE_ONLY` takes item numbers, `SUNSTONE_REG` the register folder, `SUNSTONE_DIRS` a colon list of folders to
weave and `SUNSTONE_ROUNDS` the tool rounds per item (14). Per-turn is the only mode here, because single-pass lets
one good search cover a weak retrieval habit and lets the shape of the set say which items are meant to be refused.
`run_command` is allowlisted to `python3 tools/*.py` and read-only commands; a refusal is written into the transcript
as a refusal, so a lost mark is never mistaken for the model declining to run a check. The first run pays for
indexing and it is long; the store it built is named in the output, because a locate score is a property of the store
as much as of the model.

**Tool calling.** GLM-4.7-Flash parses tool calls cleanly on llama-server (`finish_reason: tool_calls`, valid JSON,
multi-turn tool results) with thinking on or off; that is the model to run agent mode on today. gpt-oss-20b reasons
before every answer (harmony); we send `reasoning_effort: low` so it does not spend its budget thinking. Kimi reads
`thinking: false`; Qwen reads `enable_thinking: false`; the provider sends all three. Structured output: use
`json_schema`, not `json_object` (the latter returns fenced markdown on llama-server), and give it 600+ tokens.

**Latency shape.** First token 0.4 to 0.8 s on the box through the tunnel. A model that is not serving loads on first
use: seconds for small ones, about a minute for 27B/31B, thirty minutes for Kimi. One model per box at a time, so a
team sharing a box shares a model; give each workflow its own box or accept the swap.

**Prompt cache and slots.** A router child runs with 4 slots; slot choice can miss the cached prefix (we measured
cache hits of 0 on some turns while others hit 250+). For a single-user agent box, `-np 1` in the preset pins the
slot and the cache. This is a one-line change to `box_preset.py` when we want it.

**Retrieval versus grep.** The weave finds by meaning and by identifier stem; `grep` finds by exact string. They are
complementary: tell the agent (custom instructions, §4) to `#weave` first for "where is / how does", then grep to
confirm. The weave ranks code chunks with their enclosing definition, so hits are usable as-is in the prompt.

**Memory hygiene.** Woven passages, lookups and `#remember` notes share one store per workspace. Lookups and memory
notes are de-duplicated by text; woven files are replaced on save and dropped when deleted. `Forget a Woven Folder`
removes a folder's passages. Nothing leaves the machine except the model requests to the place you chose.

**Security.** Keys are in VS Code's secret store, never in settings or the page's storage. The page runs on a loopback
origin with a random path token. The provider sends `Authorization: Bearer` only to the place's own URL. Model output
is never executed by Sunstone; agent mode's own tool approvals still apply.

**Cost.** A 3090 box is about $0.30 to $0.50 an hour on vast; the 1 TB RAM box that holds Kimi is about $1 to $2. A
day of agent work on GLM is a coffee. Stop the box when done (M4 puts that in the tree).

## 3. What we can leverage right now

Each of these works with what is committed today.

1. **Agent mode on our own model over a woven repo.** Pick `GLM-4.7-Flash · box`, weave the repo, work as usual. The
   first measurable win is the prompt cache: a long session costs prefill only for the new turn.
2. **A reviewer that is not the author.** Run the coding session on GLM and ask `Kimi-K2.6 · box` (or gpt-oss-20b, a
   different family) to review the diff: `#weave` gives it the surrounding code; a second model family catches what
   the first family's blind spots miss. Two picks in one chat, no other setup.
3. **Whole-document understanding without the window.** `#digest research/notes/box_router.md` produces ordered notes
   that are indexed; the next question about that file is answered from notes, not from a truncated read. Do it once
   for every long design note, changelog and paper in the repo; the notes persist.
4. **Cited facts inside the coding loop.** `#lookup` with `where: web` reads the site's search; with the default it
   reads Wikipedia; `where: news` reads the desk. A library's release date, an RFC section, a CVE's affected
   versions, cited in the answer instead of recalled.
5. **Project memory across chats.** `#remember` decisions as they are made ("we key secrets by URL, not by name").
   `@blackwindow` keeps its own turns. Next week's chat starts with `#weave what did we decide about secrets`.
6. **The bench harnesses as agent tasks.** `research/bench/*.py` already print machine-readable lines. Tell the agent
   to run `box_caps.py` against a place and read the result; it can, today, through the terminal tool. M5 makes them
   first-class, but nothing stops us now.
7. **Offline.** *Start llama-server on This Machine* with the Mac app's GGUFs, pick `Qwen3.5-9B · local`, weave the
   repo. No network needed for the model or the memory; only `#lookup` reaches out.
8. **The same page on a phone, on the box, in the editor.** The weave format is the page's session export. A session
   saved from the phone opens in the editor's page and vice versa; the standalone panel and the phone share one
   memory format.

## 4. Two files to drop into a repo

**Custom instructions** (`.github/copilot-instructions.md`) so any model in the picker uses the memory first:

```markdown
When asked where something is or how it works in this repository, call the Black Window weave search (#weave) before
reading files or grepping, and cite the passages you used. For a whole file's meaning use #digest rather than reading
it into the context. Record decisions with #remember, one sentence each. Facts about libraries, dates or events go
through #lookup and are cited.
```

**A Black Window agent** (`.github/agents/blackwindow.agent.md`) that pins the tools and the voice:

```markdown
---
description: Works from the woven folders first, cites what it reads, remembers decisions.
tools: ['blackwindow_weave_search', 'blackwindow_digest', 'blackwindow_lookup', 'blackwindow_remember', 'search', 'editFiles', 'runInTerminal']
---
You are working inside this repository with Black Window's memory. Search the weave before reading files. Lead with
the fact; full sentences; cite [n] for anything taken from a passage or a lookup. When you settle something, remember
it in one sentence. Do not announce that something is important; state it.
```

Pick that agent with a Black Window model in the picker and the whole loop runs on our stack.

## 5. What to build next, in order of leverage

1. **`-np 1` in the box preset** for agent boxes: one line, recovers the prompt cache on every turn.
2. **Weave scope in the tool result**: return the passage's line range so the agent can open exactly there
   (`chunkCode` knows the line; the tool should say it).
3. **`#weave` over the diff**: a tool that weaves the working tree's changes on demand, so a review model sees only what
   moved plus its neighbourhood.
4. **Places in the tree with rent/stop** (M4) so the box's cost is a click.
5. **Bench harnesses as tasks with a results view** (M5): the agent measures the model it runs on.
6. **A second weave reader for code** (a code-tuned embedder beside bge-small) when a measurement shows the gap; not
   before.

## 6. What this is not

It is not a replacement for `@workspace` (which the built-in chat indexes its own way) nor for the built-in tools; it
sits beside them. It is not a hosted service: every model and every passage is on hardware you chose. And it is not
finished: the numbers above are one day's measurements on one box; the plan's M4 to M6 are what turn today's
capability into a product.
