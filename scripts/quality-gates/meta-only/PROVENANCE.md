# Provenance: shared meta-only quality pack

The rules and Paperclip checklist are a curated snapshot of a shared quality
asset set imported on 2026-10-11. Rule semantics and fixture structure are
preserved; explanatory examples and imported validation metadata were
sanitized for this public repository. Source repository names, private issue
and pull-request references, commit identifiers, and host paths are omitted.

- Rule definitions and the checklist were imported as a shared asset snapshot.
- Validation snapshots under `rules/tests/__snapshots__/` were generated here
  with the pinned CLI (`npx --package @ast-grep/cli@0.50.0 ast-grep test
  -c sgconfig.yml --update-all`). They lock fixture behavior so
  `ast-grep test` remains a regression check.

## Resync procedure

1. Import the reviewed shared `rules/` and `checklists/paperclip.yaml` snapshot;
   preserve its rule semantics and remove source-private metadata before commit.
2. Regenerate snapshots with `ast-grep test -c sgconfig.yml --update-all`
   using the pinned CLI, from inside `rules/`.
3. Run `pnpm test:quality-gates` and `pnpm lint:ast-grep`. A resync that changes
   findings is a loud change and should be named in the PR.

## Known upstream gaps

- The original asset bundle did not include `tests/__snapshots__/`, so its
  fixtures required snapshot generation before they could be verified locally.
- `golden-findings.jsonl` and `non_ast.py` were referenced but not present in
  the bundle. Only the AST rules and checklist are included here. The
  repository's own lockfile and migration checks remain separate gates.
