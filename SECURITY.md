# Security

## Reporting

Report privately through GitHub's advisory form:
**https://github.com/katuyukinoadres-beep/agent-eval/security/advisories/new**

Please do not open a public issue for anything that affects the confidentiality
of someone's logs. Expect a first reply within a week.

## What this tool touches

Worth knowing before you assess it — the full account is in
[docs/PRIVACY.md](docs/PRIVACY.md).

- It **reads every Claude Code transcript on the machine**, plus settings files
  and skill filenames.
- It **makes no network requests at all.** There are zero runtime dependencies
  and `dist/` uses only the Node standard library.
- It writes nothing unless `--store` is passed. With it, snapshots and a
  machine-local key go under `~/.agent-eval/`.
- It runs exactly two subprocesses, both `git`, both read-only: `git log
  --format=%cd --date=short` under `--repo`, and `git ls-files
  --error-unmatch` to refuse a snapshot store that someone has committed.

## What counts as a vulnerability here

Anything that gets conversation content, file paths, usernames, or home
directories out of the process — into the payload, into a snapshot, into
stdout, or onto the network. The payload is designed to carry counts and keyed
hashes only.

Two things are documented rather than defended, so they are not findings on
their own — but a way to *exploit* them is:

- **Project ids are unsalted SHA-256** of the directory name, deliberately, so
  the same project matches across machines. Guesses can therefore be confirmed.
- **Signature MACs commit to a failure tuple.** They are unreadable without the
  machine's key, but a key holder can test a guess against one.

## Supported versions

The latest published version. This project is pre-1.0 and fixes go forward.
