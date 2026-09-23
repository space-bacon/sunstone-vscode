# Security

## Reporting

Email **burton@sunstonenorth.com**. Please do not open a public issue for a vulnerability.

Include what you did, what happened, and the version from the Extensions view. A proof of concept
helps and is not required. You will get a reply within three working days.

## What this extension does with your data

The claims below are the ones worth checking rather than trusting, and the code to check them is in
this repository.

- **The index and the text stay on the machine that runs the extension.** Woven folders are read,
  split and embedded locally. The passages are held in the editor's workspace storage.
- **The extension host makes no outbound connection of its own.** `src/` contains no non-loopback
  URL. The page server binds to `127.0.0.1` only.
- **Two things do leave, and both are invoked by name.** The `lookup` tool fetches from Wikipedia or
  a news source, because that is what it is for. A place you add is a server you chose, and your
  prompts go to it.
- **A hosted model you pick in the editor's own model picker** is between you and that vendor as
  usual. This extension does not insert itself into that path.

## Keys

A place's key is kept in the editor's `SecretStorage` under `sunstone.key:<url>`. It is never
written to `settings.json`, never written into the page's storage, and never passed on a command
line. If you find a path where a key is logged, written to disk, or included in a prompt, that is a
vulnerability and we want to hear about it.

## The loopback server

The standalone page is served from `127.0.0.1` on a port you control (`sunstone.port`, 47393 by
default). It is token-gated. The origin is deliberate rather than incidental: Chromium treats
`http://127.0.0.1` as a secure context, which the workers, the wasm and the page's service worker
all require, so it cannot be replaced with a webview resource scheme.

If you can reach that server from another machine, or drive it without the token, report it.

## Shell execution

The assessment commands run shell commands in the workspace folder, against an allowlist, with
stdin closed and a timeout. They are opt-in and are not part of ordinary chat. A way to reach
command execution from a model's output without the user invoking an assessment is a vulnerability.

## Supported versions

The most recent published version. This extension is pre-1.0; fixes land on the newest release
rather than being backported.
