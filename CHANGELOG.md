# Changelog

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
