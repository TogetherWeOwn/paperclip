#!/usr/bin/env node
/**
 * Checks the required PR title, body sections, and automation provenance.
 * Export: checkTemplate(body, title) → { passed: boolean, failures: string[] }
 */
import { fileURLToPath } from 'node:url';

const REQUIRED_SECTIONS = [
  '## Why',
  '## What',
  '## Validation',
  '## Risk and rollback',
  '## Automation provenance',
  '## References',
];
const TITLE_PATTERN = /^(?:feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9._/-]*\))?(?:!)?: [a-z][^\n]+$/;
const IMPERATIVE_VERBS = new Set(['add', 'align', 'allow', 'block', 'build', 'change', 'clean', 'clarify', 'configure', 'create', 'delete', 'disable', 'document', 'enable', 'enforce', 'fix', 'guard', 'harden', 'implement', 'improve', 'make', 'migrate', 'move', 'prevent', 'preserve', 'refactor', 'reject', 'release', 'remove', 'rename', 'replace', 'require', 'restore', 'revert', 'route', 'sanitize', 'simplify', 'support', 'test', 'update', 'use', 'validate', 'verify', 'wire']);
const PLACEHOLDER = /(?:<(?:name|email|model|provider|version|value)(?:\s+[^>]*)?>|\b(?:unknown|tbd|todo|placeholder|model name|provider|n\/a)\b)/i;
const SECRET_LIKE = /(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|(?:token|secret|password|private[_ -]?key|credential)\s*[:=]\s*\S+)/i;

function sections(body) {
  const result = new Map();
  let current = null;
  for (const line of String(body ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.trim().match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = `## ${heading[1]}`;
      if (!result.has(current)) result.set(current, []);
    } else if (current) result.get(current).push(line);
  }
  return result;
}

function visible(content) {
  return String(content ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function titleIsImperative(title) {
  const subject = String(title ?? '').replace(/^(?:feat|fix|docs|test|refactor|perf|build|ci|chore|revert)(?:\([a-z0-9][a-z0-9._/-]*\))?(?:!)?:\s*/, '');
  return IMPERATIVE_VERBS.has(subject.toLowerCase().match(/^[a-z]+/)?.[0]);
}

export function checkTemplate(body, title = '') {
  const failures = [];
  const parsed = sections(body);

  if (!TITLE_PATTERN.test(title) || !titleIsImperative(title)) failures.push('PR title must use `<type>[optional scope][optional !]: <imperative outcome>`.');

  for (const heading of REQUIRED_SECTIONS) {
    const occurrences = String(body ?? '').split(/\r?\n/).filter((line) => line.trim().toLowerCase() === heading.toLowerCase()).length;
    const content = visible(parsed.get(heading)?.join('\n'));
    if (occurrences !== 1 || !content || /^-\s*$/.test(content)) failures.push(`Section must appear once with visible content: **${heading}**`);
  }

  const provenance = visible(parsed.get('## Automation provenance')?.join('\n'));
  if (provenance) {
    const preparers = [...provenance.matchAll(/^[-*]\s*Prepared by:\s*(.+)\s*$/gim)].map((match) => match[1].trim());
    const models = [...provenance.matchAll(/^[-*]\s*Model\(s\):\s*(.+)\s*$/gim)].map((match) => match[1].trim());
    if (preparers.length !== 1 || !['TogetherWeOwn automation', 'Human'].includes(preparers[0])) failures.push('**Automation provenance** must contain exactly one approved preparer.');
    if (models.length !== 1 || PLACEHOLDER.test(models[0]) || SECRET_LIKE.test(models[0]) || /(?:agent\s*:|@|https?:|[A-Z0-9._%+-]+@[A-Z0-9.-]+)/i.test(models[0])) failures.push('**Automation provenance** must contain exactly one factual model list, or `None` for a human-only change.');
    if ((preparers[0] === 'Human') !== (models[0] === 'None')) failures.push('Human provenance must use `Model(s): None`; automation must name a model.');
    if (/\b(?:co-authored-by|signed-off-by|author|committer|agent persona)\b/i.test(provenance)) failures.push('Automation provenance must not claim Git attribution or an agent persona.');
  }
  if (SECRET_LIKE.test(String(body ?? ''))) failures.push('PR body must not contain secret-like values.');

  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = checkTemplate(process.env.PR_BODY ?? '', process.env.PR_TITLE ?? '');
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
