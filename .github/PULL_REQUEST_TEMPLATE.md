<!-- Write all pull request text in Simplified Technical English. Use short sentences and active voice. Do not expose internal Paperclip ticket ids, instance links, or task-derived branch names. -->

## Why

<!-- State the problem, requirement, or user need. -->

-

## What

<!-- State the solution and material design decisions. Do not narrate the diff. -->

-

## Validation

<!-- List exact tests, checks, manual verification, benchmarks, or screenshots. -->

-

## Risk and rollback

<!-- State affected systems and an exact rollback. Use "Low risk" only when true. -->

-

## Automation provenance

<!--
Required. Record automation facts here only. Do not add a model, provider, tool,
Paperclip, or agent persona to Git authorship, co-author, sign-off, mentions,
reviewers, assignees, or contributors.

Use the actual full model name and version. List each materially contributing
model once. Do not include an email, URL, GitHub mention, secret, agent persona,
or configured fallback. For a human-only change use:
- Prepared by: Human
- Model(s): None
-->

- Prepared by: TogetherWeOwn automation
- Model(s): <full model name and version>

## References

<!--
Link PUBLIC GitHub issues/PRs or other public records only. Use Fixes/Closes/Refs
when applicable. If no issue exists, describe the problem fully in Why. Never
include internal ticket ids, instance URLs, agent:// links, localhost, or private
network URLs.
-->

-

## Merge exception

<!-- Use "None — squash and merge" or document why topology/history must remain. -->

None — squash and merge

## Checklist

- [ ] The PR title follows `<type>[optional scope][optional !]: <imperative outcome>`
- [ ] I used a descriptive public branch name with no internal issue identifier
- [ ] I ran the listed validation and added or updated tests where applicable
- [ ] I documented an exact rollback
- [ ] Automation provenance is factual and appears only in this PR section
- [ ] The final company commit uses the approved owner author and exactly one TogetherWeOwn co-author trailer, unless a documented upstream/dependency exception applies
- [ ] All required CI, review, and conversation-resolution gates pass
