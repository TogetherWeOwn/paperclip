# Provenance: shared meta-only quality pack

The `rules/` tree and `checklists/paperclip.yaml` here are wired from the
shared asset branch instead of rewritten (owner directive 2026-10-11).

- Source: `TogetherWeOwn/paperclip-ops-tooling`, branch
  `quality/meta-only-assets` at `a10103b5f8c9846b8d12cc2d19c7bc2246d12349`
  (ops-tooling PR #882, `quality/meta-only/`).
- `rules/` is a byte-for-byte copy of the upstream `rules/` directory at
  that SHA (verified with `diff -r`). Do not hand-edit it.
- `checklists/paperclip.yaml` is a byte-for-byte copy of the upstream
  paperclip review checklist (Muse one-question-per-request protocol).
- `rules/tests/__snapshots__/` is the only generated content on our side:
  produced with the pinned CLI (`npx --package @ast-grep/cli@0.50.0
  ast-grep test -c sgconfig.yml --update-all`). It locks the fixture
  behavior so `ast-grep test` stays a real regression check.

## Resync procedure (when the asset branch merges or updates)

1. Copy the new upstream `rules/` and `checklists/paperclip.yaml` over
   this directory, then `diff -r` the shared files.
2. Regenerate snapshots: `ast-grep test -c sgconfig.yml --update-all`
   with the pinned CLI, from inside `rules/`.
3. Run `pnpm test:quality-gates` and `pnpm lint:ast-grep`. A resync that
   changes findings is a loud change: name it in the PR.

## Known upstream gaps (flagged, not forked)

- The asset branch ships no `tests/__snapshots__/`, so a plain
  `ast-grep test -c rules/sgconfig.yml` fails there (26/26 snapshot
  mismatches). Their validator must be generating snapshots first.
- `golden-findings.jsonl` (cited as `rationale_source` in the checklist)
  and `non_ast.py` (cited by `rules/NON-AST.md`) are not on the branch,
  so only the ast-grep rules and the checklist are wired here. The
  NON-AST recipes that already exist in this repo (lockfile inventory,
  migration ordering) keep running under their own gates.
