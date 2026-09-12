import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTemplate } from '../check-pr-template.mjs';

const VALID_BODY = `
## Why
The current policy can credit tools as authors.

## What
Replace tool credit with factual pull request provenance.

## Validation
Run the focused policy tests.

## Risk and rollback
Low risk. Revert this commit to roll back.

## Automation provenance
- Prepared by: TogetherWeOwn automation
- Model(s): gpt-5.6-sol

## References
- Public issue or not applicable.
`;

test('passes a conventional title and complete body', () => {
  assert.deepEqual(checkTemplate(VALID_BODY, 'fix(policy): reject false attribution'), { passed: true, failures: [] });
});

test('accepts a breaking conventional title', () => {
  assert.equal(checkTemplate(VALID_BODY, 'feat(api)!: remove legacy sessions').passed, true);
});

test('fails an invalid or non-imperative title', () => {
  assert.equal(checkTemplate(VALID_BODY, 'Update policy').passed, false);
  assert.equal(checkTemplate(VALID_BODY, 'fix(policy): attribution validation').passed, false);
});

test('fails each missing or empty required section', () => {
  for (const heading of ['Why', 'What', 'Validation', 'Risk and rollback', 'Automation provenance', 'References']) {
    assert.equal(checkTemplate(VALID_BODY.replace(`## ${heading}`, '## Removed'), 'fix(policy): update checks').passed, false);
    assert.equal(checkTemplate(VALID_BODY.replace(new RegExp(`## ${heading}\\n[\\s\\S]*?(?=\\n## |$)`), `## ${heading}\n-\n`), 'fix(policy): update checks').passed, false);
  }
});

test('rejects placeholder, mentions, URLs, emails, and agent personas in provenance', () => {
  for (const value of ['<full model name and version>', '@claude', 'https://models.example/gpt-5', 'agent: Director', 'model@example.com']) {
    assert.equal(checkTemplate(VALID_BODY.replace('gpt-5.6-sol', value), 'fix(policy): update checks').passed, false);
  }
});

test('rejects duplicate, contradictory, hidden-only, and secret-like provenance', () => {
  for (const body of [
    VALID_BODY.replace('- Model(s): gpt-5.6-sol', '- Model(s): gpt-5.6-sol\n- Model(s): sonnet-5'),
    VALID_BODY.replace('TogetherWeOwn automation', 'Human'),
    `${VALID_BODY}\n## Why\nduplicate`,
    VALID_BODY.replace('Run the focused policy tests.', '<!-- hidden -->'),
    VALID_BODY.replace('gpt-5.6-sol', `token=github_pat_${'x'.repeat(24)}`),
    VALID_BODY.replace('- Model(s): gpt-5.6-sol', '- Model(s): gpt-5.6-sol\n- Co-Authored-By: Model <model@example.com>'),
  ]) assert.equal(checkTemplate(body, 'fix(policy): update checks').passed, false);
});

test('allows a human-only provenance record', () => {
  const body = VALID_BODY
    .replace('TogetherWeOwn automation', 'Human')
    .replace('gpt-5.6-sol', 'None');
  assert.equal(checkTemplate(body, 'docs: clarify human contribution flow').passed, true);
});
