# Sunstone

**Put your own model servers in VS Code's model picker, and give them a memory of your folders.**

Sunstone adds two things to the editor. A place is anywhere a model runs, this machine, a Mac on your
network, a box you rent or a server you host, and every model a place serves appears in the same picker
as the built-in ones, usable by chat, by edits and by agent mode. The weave is a local index over the
folders you choose, searched through a tool the model calls, so an agent can find where something is
defined without being told the path and without sending your code anywhere.

Both run on hardware you control. A place's key is held in the editor's SecretStorage, never in
`settings.json` and never in the page's storage. The weave is embedded and stored on your machine.

## What is measured

Every figure here carries the population it came from.

| | measured | population |
|---|---|---|
| The weave finds the file an issue is about | `recall@1` **229/500 (0.458)** against a permuted-query floor of **5/500 (0.010)** and a text-search arm at **58/500 (0.116)** | every instance of SWE-bench Verified, twelve repositories, one store per instance at its own `base_commit`. django is 46.2% of the set, and per-repository recall runs 0.265 to 0.688 |
| A prompt past the model's window is folded into the weave rather than refused | a fact **154,699 characters past the cut** returned verbatim in **32.1 s** | one arm on GLM-4.7-Flash at `n_ctx` 131,072, cut at 92,160 characters |
| Giving an agent the register instead of leaving it to grep | **52.00 against 44.25 of 56** (Claude Sonnet 5) and **53.00 against 44.75** (Opus 5), reading **4.6x and 3.8x less tool output** and finishing 2.7x and 3.5x faster | 56 items generated from a claim ledger with the figures stripped from the question, 4 runs an arm, 224 item-runs an arm. The control holds `grep` and `cat` over the same files and is denied the weave and the verdict tool. The arms never overlap: the worst run with it beats the best run without it on both models |
| Indexing rate through `indexFolder`, reading and chunking included | **267 passages a second** | 10 files, 454 passages in 1.7 s, WebGPU in the VS Code webview on an M2 Ultra |

That row is measured against a competent control rather than a straw one: the arm without the weave
keeps `grep` and `cat` over every file of the corpus. What it does not establish is how the gap moves
as a corpus grows, because the ledger it searches is 130 lines. Both models are from one vendor.

## Getting started

Open the Sunstone view in the sidebar. To use a model, add a place: start a llama.cpp server on this
machine with one command, or paste the pairing line from a box you already run. To give it a memory,
right-click a folder and choose **Black Window: Weave This Folder**, then use `#weave` in agent mode or
`@blackwindow` for answers with citations.

The suite's page is at [blackwindow.xyz](https://blackwindow.xyz), which runs the same engine this
extension hosts, in a browser tab, with no account.

---

Sunstone is the VS Code surface of the Black Window suite: the browser page at
[blackwindow.xyz](https://blackwindow.xyz), the Mac app, the vast.ai templates, the box router and the
bench harnesses. Everything the extension does is something the suite already does somewhere else
today. Sunstone is the place they meet.

Status: M3 done, plus **Black Window in the model picker** (a `LanguageModelChatProvider`: every place's models,
router-aware, tools mapped both ways, each model's window read from the server and the overflow folded into the
weave rather than refused). Black Window runs inside VS Code's own chat: weave the folders you pick, then
`#weave`, `#lookup`, `#digest`, `#remember` in agent mode, or `@blackwindow` (with `/weave`, `/lookup`, `/news`,
`/digest`) for the house voice with citations, on any model in the picker. The weave persists between sessions.
Next: M4, places and vast.

Commands: `Black Window: Weave This Folder` (folder context menu), `Search the Weave`, `Forget a Woven Folder`;
`Sunstone: Open Black Window` (the standalone page), `Add a Place`, `Load a Model`, `Start llama-server on This
Machine`, `Ask About the Selection` (`cmd+alt+b`), `Insert the Last Reply`. Chat: `@blackwindow`, `/weave`, `#weave`.

The source tree carries `docs/QUICKSTART.md`, `docs/WHAT_TO_EXPECT.md`, `docs/BENCHMARKS.md` and
`docs/ADVANCED.md`, along with `docs/M0.md` to `docs/M3.md` and `PLAN.md`. They are named rather than
linked because the repository is private and the Marketplace rewrites a relative link into a URL that
would return 404.

Develop: `npm install`, `./scripts/sync-engine.sh` (needs a `blackwidow` checkout beside this one with
`engine/dist` built), `npm run build`, then F5 in VS Code, or `npm run spike` for the M0 feasibility run.
`npm run package` builds the VSIX and runs `scripts/check-vsix.sh`, which fails the build if anything
outside `out/extension.js`, `media/`, `resources/`, the licence and the changelog is in the package.

Publisher: Sunstone North Lab LLC, Marketplace id `sunstonenorth`.


Related repositories:

- [space-bacon/blackwidow](https://github.com/space-bacon/blackwidow): the engine (browser page, Mac app, runtime and
  geometry crates, gateway, bench harnesses). Sunstone consumes its build output; it does not fork it.
- [space-bacon/SRT](https://github.com/space-bacon/SRT): the research repository (adapters, heads, papers).
