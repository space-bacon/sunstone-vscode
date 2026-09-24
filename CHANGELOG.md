# Changelog

## 0.1.3

A review of 0.1.2's freshness path found seven cases it got wrong. Each is now a check in
`npm run fresh`, each failed on 0.1.2, and all sixteen checks pass here: from an empty store, from a
restored one, and with the extension loaded from the installed package rather than the source tree.

- A file written after the weave into a path the folder walk excludes was indexed by the next
  search anyway. Build output under `out/`, a virtualenv, and a directory kept out by
  `sunstone.weave.exclude` were all returned by search on 0.1.2. A new file is now asked of the
  walk's own include and exclude globs through the same `findFiles` call, and saves take that path
  too, which they did not either.
- A directory deleted whole left its files answering. The watcher reports the directory once rather
  than each file under it, and that event was discarded for having no text extension. A path that
  is gone now takes every source under it with it.
- A renamed directory went on answering under its old path and never under the new one. A
  directory that appears is now walked.
- Searches issued together, as a model's parallel tool calls are, did not all see a write. Of three,
  one returned the new text and two the old. One freshen runs at a time, and a search that arrives
  during one waits for it.
- In a session whose store was built rather than restored, which is every first session after
  install, a re-weave with nothing changed re-embedded every file, 3 of 3 in the test folder. The
  0.1.2 note below says a rescan costs "a directory walk rather than a re-embed", which held only
  after a reload. Unchanged files are now skipped either way.
- A folder below the top of its repository, and a linked worktree or a submodule, read an empty
  git stamp, so a branch switch there was caught only if the watcher delivered it. The stamp now
  finds the repository above the folder and follows a `.git` file to its git directory.

An external write was searchable in 75, 77 and 77 ms on this version's three runs, and in 77 to
191 ms on four runs of 0.1.2 today, where the 0.1.2 note gives one run's 74 ms. The limit stated for
0.1.2 still holds: the suite runs on macOS, where the watcher does not overflow, so the stamp path is
confirmed rather than isolated.

`@blackwindow` no longer keeps its replies. Each turn used to go into memory as the question and the
whole answer, and later searches returned that answer as though it were a source, so an earlier reply,
right or wrong, could be cited back as evidence. It now keeps the question and the sources the reply
cited, and a later search leads to those sources as they are now. Replies kept by earlier versions
stay in the store and come back labelled as an earlier answer, not a source.

The listing's third measured row now names both things the measured arm held, the store and a
verdict tool over the claims ledger, because the extension ships the store and not the verdict tool.
The figures are unchanged.

## 0.1.2

A bulk rewrite no longer depends on the watcher noticing it. Dipankar Sarkar again: `git checkout`
can rewrite hundreds of files at once, and on Linux inotify's queue overflows and drops the events.
He suggested rescanning when the watcher reports an overflow. The VS Code API exposes no such
signal, `vscode.d.ts` has no mention of overflow at all, so nothing in the watcher path can know it
happened.

Freshness therefore no longer rests on events being delivered. Each search reads a generation stamp
for every woven folder, the branch and the commit it points at, taken from `.git/HEAD` and the ref
it resolves to. A read cannot be dropped. When the stamp moves, the folder is rescanned, and
`indexFolder` skips files whose mtime is unchanged, so the cost is a directory walk rather than a
re-embed. Files the new tree does not have leave the index, which the existing walk already handled.

Separately, more than 64 files marked at once escalates to a folder rescan rather than 64 individual
re-reads. That catches bulk changes with no git involved, and the siblings whose events were dropped.

`npm run fresh` now runs nine checks, all passing: external write returned in 74 ms, old text gone,
unsaved buffer's text is what search returns, deleted file drops out, branch switch returns the new
branch's text, drops the old, and a file that exists only on the other branch leaves the index when
you switch away.

One limit on that evidence. The suite runs on macOS, where FSEvents does not overflow the way
inotify does, so the watcher fires as well and the run confirms the outcome rather than isolating the
stamp. The stamp exists precisely for the platform where the watcher cannot be trusted, and that
path is unmeasured here.

## 0.1.1

A search now answers from the file as it is, not as it was when something last saved it. Dipankar
Sarkar put the gap plainly: grep is never stale, and an index that returns the pre-edit version of a
function can send an agent in circles.

The index was only refreshed by `onDidSaveTextDocument`, debounced 1500ms. That misses the two cases
that matter while an agent works. An agent writing through a shell command, a patch tool or a git
checkout never raises a save event at all, and an unsaved buffer is already different from the file
that was indexed.

Staleness is now tracked from three sources and resolved before a query rather than after a write.
`onDidChangeTextDocument` marks a buffer on the keystroke, a `FileSystemWatcher` on each woven
folder catches writes that never reach the editor, and `search()` re-indexes what is marked before
it reads. Marking is a set insert; only files that actually changed are re-read, so an unchanged
workspace pays nothing. A dirty buffer is indexed from its in-memory text rather than from disk, and
keeps the mtime of the file on disk so the save that follows is not skipped as unchanged. A deleted
file is dropped from the index instead of being returned as a path the agent will try to open.

`npm run fresh` is the acceptance run, writing `out/test/fresh.json`. Measured on one file: a write
from outside the editor is reflected in **75 ms**, an unsaved buffer's text is what search returns,
and a deleted file leaves the index. The old text is gone in every case, which is the part that
sends an agent in circles.

## 0.1.0

The first published version told you nothing about weaving, which is the step everything else
depends on. Nothing is indexed until you ask, and a fresh install therefore answered out of an
empty store while the models fell back to `grep`. Two `viewsWelcome` entries said so and neither
could render, because welcome content only shows when a view is empty and the Places tree always
returns its two groups. There is now a prompt on activation when the workspace has folders and the
weave has none, offering to weave or to open the guide.

`docs/GUIDE.md` ships with the extension and opens from **Sunstone: Open the Guide** or the book
icon in the Places title bar. It covers weaving and why it comes first, the five tools, servers in
the picker both local and remote, the window folding, the standalone page, packs, every setting
with its default, and what to do when each part misbehaves.

`extensionKind` is declared as `ui`. It was unset, and VS Code prefers `workspace` when it is, which
in a remote window puts the extension host on the remote while the webview still resolves
`127.0.0.1` to the local machine. For a local workspace nothing changes.

The source map now ships. Every 0.0.1 build ended with a `sourceMappingURL` pointing at a file the
package excluded, so devtools got a 404.

The Licensor is named as Sunstone North Lab LLC, and the source is public at
[space-bacon/sunstone-vscode](https://github.com/space-bacon/sunstone-vscode).

## 0.0.1

First release. Requires VS Code 1.104 or later, which is the first version carrying the language model
chat provider API this extension registers at activation.

- **Your own servers in the model picker.** Add a place by pasting its pairing line, and every model it
  serves appears alongside the built-in ones. A place's key is held in SecretStorage, never in
  `settings.json` and never in the page's storage.
- **A local server.** Start and stop llama.cpp from the editor, with a key generated on first run for
  this install alone.
- **Add a model to a box.** Name a Hugging Face repository and a router box downloads it, with progress
  reported as it arrives.
- **The weave.** Woven folders are embedded on the machine and searched by the model through a tool, so
  history a model's window cannot hold stays reachable. On SWE-bench Verified the weave puts the gold
  file first for 229 of 500 instances, against 5 for the same query permuted onto another instance and
  58 for text search.
- **Overflow is folded rather than refused.** A prompt past the model's window goes into the weave and
  is reached again through `bw_recall`. Measured on GLM-4.7-Flash at `n_ctx` 131,072: a fact 154,699
  characters past the 92,160-character cut returned verbatim in 32.1 s.
- **The assessment.** Run an item set against any model in the picker and record what each answered, how
  many tool calls it took and which asserted values appeared in something it was shown.
- **The Black Window page**, hosted in the editor, with the same engine that runs at blackwindow.xyz.
