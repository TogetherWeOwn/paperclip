#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

export const COMPANY_AUTHOR = 'Rick7C2 <rick.dugger@gmail.com>';
export const COMPANY_COAUTHOR = 'Co-Authored-By: TogetherWeOwn <319968614+togetherweown[bot]@users.noreply.github.com>';
const forbiddenIdentity = /(?:paperclip|claude|anthropic|openai|chatgpt|codex|gemini|copilot|cursor|gpt[- ]?\d|sonnet|opus|haiku|llama|mistral|deepseek)/i;

export function checkCommitAttribution(commit, options = {}) {
  const failures = [];
  const author = `${commit.author?.name ?? ''} <${commit.author?.email ?? ''}>`;
  const coauthors = String(commit.message ?? '').split(/\r?\n/).filter((line) => /^co-authored-by:/i.test(line.trim()));
  const dependencyException = options.allowPreservedAuthorship === true;

  if (!dependencyException && author !== COMPANY_AUTHOR) {
    failures.push(`${commit.sha}: author must be ${COMPANY_AUTHOR}.`);
  }
  if (!dependencyException && (coauthors.length !== 1 || coauthors[0] !== COMPANY_COAUTHOR)) {
    failures.push(`${commit.sha}: commit must contain exactly one trailer: ${COMPANY_COAUTHOR}`);
  }
  const identityMetadata = [author, commit.committer?.name, commit.committer?.email, ...coauthors].join('\n');
  if (forbiddenIdentity.test(identityMetadata)) {
    failures.push(`${commit.sha}: model/vendor/tool identities are not allowed in Git attribution metadata.`);
  }
  const signoffs = String(commit.message ?? '').split(/\r?\n/).filter((line) => /^signed-off-by:/i.test(line.trim()));
  if (!options.dcoRequired && signoffs.length) {
    failures.push(`${commit.sha}: Signed-off-by is allowed only for a documented DCO/upstream requirement.`);
  }
  return failures;
}

export function checkCommits(commits, options = {}) {
  const failures = commits.flatMap((commit) => checkCommitAttribution(commit, options));
  return { passed: failures.length === 0, failures };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const commits = JSON.parse(process.env.PR_COMMITS ?? '[]');
  const result = checkCommits(commits, { dcoRequired: process.env.DCO_REQUIRED === 'true' });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}
