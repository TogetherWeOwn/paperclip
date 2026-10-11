# Non-AST deterministic checks

These checks complement syntax-aware rules with bounded evidence from CI and
repository tooling. This document describes check families; it does not install
or activate additional production gates.

## Exact-head CI status

Evaluate required checks on the exact proposed commit, using the trusted
repository's required-check and producer configuration. A stale green result,
skipped check, or missing check is not a pass. Use repository-native CI
producers rather than assuming check names are portable across projects.

## Test inventory and changed-line coverage

A test file's presence is not proof that a runner executed it. Track expected
test targets and their explicit runner commands. For changed-line coverage,
use the repository's supported coverage provider and compare against the merge
base; reject empty or missing reports. Coverage measures execution, not the
quality of assertions.

## Other useful bounded checks

- Mutation tests can reveal vacuous assertions, but require a passing baseline
  and a behavioral failure for each intentional mutation.
- Generated-file checks require both a reproducible output diff and tests for
the generator inputs.
- Lockfile and migration checks should inventory every relevant file and
  validate compatibility without applying production migrations.
- Text-integrity checks should inspect bytes as well as parsed syntax, since
  AST tooling does not reliably scan binary data.

Prefer isolated fixtures for parser, workflow, and shell checks. A successful
syntax parse is not evidence that a workflow executes the intended suite, and
an advisory tool failure is not a clean result.

## Repository entry point

Run `pnpm test:quality-gates` for the local deterministic gate suite. The
remaining checks in this document require repository-specific CI wiring and
should not be represented as active gates until that wiring exists.
