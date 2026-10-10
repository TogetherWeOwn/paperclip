import type {
  GitHubReviewAssessment,
  GitHubReviewFinding,
} from "@paperclipai/shared";
import { projectSafeChatPublicationText } from "./chat-publication-projection.js";
import {
  scrubInternalReferences,
  type InternalReferenceScope,
} from "./chat-publication-projection.js";

/** Hard ceiling for any single rendered review post. */
export const REVIEW_POST_MAX_CHARS = 60_000;
/** Suffix appended when a rendered post exceeds the ceiling. */
export const REVIEW_POST_TRUNCATION_SUFFIX =
  "\n\n…truncated, see the PR comment";

const SEVERITY_EMOJI: Record<string, string> = {
  info: "ℹ️",
  warning: "🟡",
  error: "🔴",
};

const SEVERITY_LABEL: Record<string, string> = {
  info: "Info",
  warning: "Warning",
  error: "Error",
};

export function githubCommitPermalink(
  repository: string,
  sha: string,
): string {
  return `https://github.com/${repository}/commit/${sha}`;
}

/**
 * File permalink at the reviewed commit. The `#L{line}` anchor is emitted
 * for completeness, but `projectSafeChatPublicationText` strips URL
 * fragments (and query strings) on publish because they can carry tokens —
 * so the visible `path:line` label, not the href, carries the line number
 * in the published post. The published href still resolves to the file at
 * the reviewed commit.
 */
export function githubFilePermalink(
  repository: string,
  sha: string,
  path: string,
  line: number,
): string {
  const encoded = path
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29"),
    )
    .join("/");
  return `https://github.com/${repository}/blob/${sha}/${encoded}#L${line}`;
}

export function githubPullPermalink(
  repository: string,
  pullNumber: number,
): string {
  return `https://github.com/${repository}/pull/${pullNumber}`;
}

/** Room reserved for the block closers a truncation cut may append. */
const TRUNCATION_CLOSER_RESERVE =
  "\nSuggestion omitted because the post was truncated.\n</details>".length;

/**
 * Slice text to at most `maxUnits` UTF-16 units, stopping only on a
 * code-point boundary so astral characters (emoji) are never split. The
 * ceiling is enforced on this unit because that is how transports and
 * `.length` measure the published post.
 */
function sliceByUtf16Length(text: string, maxUnits: number): string {
  let units = 0;
  let end = 0;
  for (const char of text) {
    if (units + char.length > maxUnits) break;
    units += char.length;
    end += char.length;
  }
  return text.slice(0, end);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Ignore tag-shaped text inside fenced suggestions when tracking details blocks. */
function hasOpenDetailsBlock(text: string): boolean {
  let openDetails = 0;
  let insideFence = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;
    openDetails += countOccurrences(line, "<details>");
    openDetails -= countOccurrences(line, "</details>");
  }
  return openDetails > 0;
}

function truncatePost(text: string): string {
  if (text.length <= REVIEW_POST_MAX_CHARS) return text;
  const keep =
    REVIEW_POST_MAX_CHARS -
    REVIEW_POST_TRUNCATION_SUFFIX.length -
    TRUNCATION_CLOSER_RESERVE;
  let cut = sliceByUtf16Length(text, Math.max(keep, 0));
  // Never cut mid-line: back up to the previous newline so a cut never
  // lands inside a link, fence or `<details>` tag.
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > 0) cut = cut.slice(0, lastNewline);
  // A shortened replacement must never be offered as an executable suggestion.
  if (countOccurrences(cut, "```") % 2 === 1) {
    cut = cut.slice(0, cut.lastIndexOf("```suggestion")).trimEnd();
    cut += "\nSuggestion omitted because the post was truncated.";
  }
  // Re-close any details block left open by the cut.
  if (hasOpenDetailsBlock(cut)) cut += "\n</details>";
  return cut + REVIEW_POST_TRUNCATION_SUFFIX;
}

/** Collapse text onto one line so it cannot introduce Markdown blocks. */
function singleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").trim();
}

/**
 * Sanitize model-controlled text before rendering it as literal Markdown.
 * Server-generated links and formatting are added separately so prose cannot
 * add Markdown or HTML. When a scope is given, this runtime's own links and
 * the company's own tracker ids are removed before escaping, because the
 * escape step backslash-escapes the punctuation the scrub patterns match and
 * GitHub renders those escapes back to the original characters.
 */
function escapeMarkdownText(text: string, scope?: InternalReferenceScope): string {
  const projected = projectSafeChatPublicationText(text);
  const scrubbed = scope ? scrubInternalReferences(projected, scope) : projected;
  let escaped = "";
  for (const character of singleLine(scrubbed)) {
    if (character === "&") escaped += "&amp;";
    else if (character === "<") escaped += "&lt;";
    else if (character === ">") escaped += "&gt;";
    else {
      const code = character.charCodeAt(0);
      const isAsciiPunctuation =
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e);
      escaped += isAsciiPunctuation ? `\\${character}` : character;
    }
  }
  return escaped;
}

/** Escape model text before placing it in a GFM table cell. */
function escapeTableCell(text: string, scope?: InternalReferenceScope): string {
  return escapeMarkdownText(text, scope);
}

function findingPermalinkPath(
  finding: Pick<GitHubReviewFinding, "path" | "side" | "basePath">,
): string | undefined {
  if (finding.side === "LEFT") return finding.basePath;
  return finding.path;
}

function findingLocationLabel(
  finding: Pick<GitHubReviewFinding, "path" | "side" | "basePath" | "line">,
  scope?: InternalReferenceScope,
): string {
  const path = findingPermalinkPath(finding);
  const location = path ? `${path}:${finding.line}` : `LEFT side, line ${finding.line}`;
  return escapeMarkdownText(singleLine(location), scope);
}

function findingFilePermalink(
  finding: Pick<GitHubReviewFinding, "path" | "side" | "basePath" | "line">,
  repository: string,
  headSha: string,
  baseSha: string,
): string {
  const path = findingPermalinkPath(finding);
  if (!path) return "";
  const sha = finding.side === "LEFT" ? baseSha : headSha;
  return githubFilePermalink(repository, sha, path, finding.line);
}

function findingLocationLink(
  finding: Pick<GitHubReviewFinding, "path" | "side" | "basePath" | "line">,
  repository: string,
  headSha: string,
  baseSha: string,
  scope?: InternalReferenceScope,
): string {
  const label = findingLocationLabel(finding, scope);
  const permalink = findingFilePermalink(finding, repository, headSha, baseSha);
  return permalink ? `[${label}](${permalink})` : label;
}

function renderSuggestionBlock(suggestion: string, scope?: InternalReferenceScope): string {
  // Never change executable replacement text, including significant indentation.
  // Project the complete block so prose trimming cannot dedent its first line.
  if (suggestion.includes("```"))
    return "Suggestion omitted because it contains an unsafe code fence.";
  const block = `\`\`\`suggestion\n${suggestion}\n\`\`\``;
  if (projectSafeChatPublicationText(block) !== block)
    return "Suggestion omitted because publication sanitization would change the replacement.";
  // The egress scrub runs after rendering and is not escaped, so it would
  // rewrite executable code. Omit instead, like the guard above.
  if (scope && scrubInternalReferences(block, scope) !== block)
    return "Suggestion omitted because publication sanitization would change the replacement.";
  return block;
}

function emojiFor(severity: string): string {
  return SEVERITY_EMOJI[severity] ?? "ℹ️";
}

function labelFor(severity: string): string {
  return SEVERITY_LABEL[severity] ?? severity;
}

export interface RenderReviewSummaryInput {
  assessment: GitHubReviewAssessment;
  repository: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  scope?: InternalReferenceScope;
}

export interface RenderInlineFindingInput {
  finding: GitHubReviewFinding;
  score: GitHubReviewAssessment["score"];
  complete: boolean;
  repository: string;
  headSha: string;
  baseSha: string;
  scope?: InternalReferenceScope;
}

function renderFindingDetails(
  finding: GitHubReviewFinding,
  index: number,
  repository: string,
  headSha: string,
  baseSha: string,
  scope?: InternalReferenceScope,
): string {
  const locationLink = findingLocationLink(
    finding,
    repository,
    headSha,
    baseSha,
    scope,
  );
  const title = escapeMarkdownText(singleLine(finding.title), scope);
  const category = escapeMarkdownText(singleLine(finding.category), scope);
  const evidence = finding.evidence
    ? ` — ${escapeMarkdownText(finding.evidence, scope)}`
    : "";
  const fix = finding.suggestion
    ? `Fix:\n${renderSuggestionBlock(finding.suggestion, scope)}`
    : "Fix: no suggestion provided.";
  return [
    `<details><summary>${index}. ${emojiFor(finding.severity)} ${labelFor(finding.severity)}</summary>`,
    ``,
    `**${title}** · ${category} · ${locationLink}`,
    ``,
    `What: ${escapeMarkdownText(finding.body, scope)}`,
    ``,
    `Evidence: ${locationLink}${evidence}`,
    ``,
    fix,
    `</details>`,
  ].join("\n");
}

/**
 * Deterministic review summary post. The model fills structured fields only;
 * this function renders all markdown. Callers sanitize the result with
 * `projectSafeChatPublicationText` before appending the idempotency marker,
 * preserving the existing sanitizer order.
 */
export function renderReviewSummary(input: RenderReviewSummaryInput): string {
  const { assessment, repository, pullNumber, headSha, baseSha, scope } = input;
  const commitUrl = githubCommitPermalink(repository, headSha);
  const pullUrl = githubPullPermalink(repository, pullNumber);
  const headline = assessment.complete
    ? `## Paperclip Review — ${assessment.score}/5`
    : `## Paperclip Review — Incomplete`;
  const lines: string[] = [
    headline,
    ``,
    `Reviewed commit: [\`${headSha}\`](${commitUrl}) ([PR #${pullNumber}](${pullUrl}))`,
    ``,
    `Files reviewed: ${assessment.coverage.reviewedPaths.length}`,
    ``,
    escapeMarkdownText(assessment.summary, scope),
    ``,
  ];
  if (assessment.findings.length === 0) {
    lines.push(
      `No actionable defects found within the stated coverage and limitations.`,
      ``,
    );
  } else {
    lines.push(
      `### Findings (${assessment.findings.length})`,
      ``,
      `| # | Severity | Finding | Location |`,
      `|---|----------|---------|----------|`,
      ...assessment.findings.map(
        (finding, i) =>
          `| ${i + 1} | ${emojiFor(finding.severity)} ${labelFor(finding.severity)} | ${escapeTableCell(finding.title, scope)} | ${findingLocationLink(finding, repository, headSha, baseSha, scope)} |`,
      ),
      ``,
      ...assessment.findings.flatMap((finding, i) => [
        renderFindingDetails(finding, i + 1, repository, headSha, baseSha, scope),
        ``,
      ]),
    );
  }
  const omitted = assessment.coverage.omittedPaths.length
    ? ` · ${assessment.coverage.omittedPaths.length} omitted`
    : "";
  const limitationText = assessment.coverage.limitations
    .map((limitation) => escapeMarkdownText(singleLine(limitation), scope))
    .join("; ");
  const limitations = limitationText ? `\nLimitations: ${limitationText}` : "";
  const rationale = assessment.rationale
    ? `\nRationale: ${escapeMarkdownText(assessment.rationale, scope)}`
    : "";
  lines.push(
    `Coverage: ${assessment.coverage.reviewedPaths.length} file(s) reviewed${omitted}${limitations}${rationale}`,
  );
  return truncatePost(lines.join("\n"));
}

/**
 * Deterministic inline finding comment. Rendered markdown only; the caller
 * sanitizes with `projectSafeChatPublicationText`, then appends the finding
 * idempotency marker.
 */
export function renderInlineFinding(input: RenderInlineFindingInput): string {
  const { finding, score, complete, repository, headSha, baseSha, scope } = input;
  const commitUrl = githubCommitPermalink(repository, headSha);
  const category = escapeMarkdownText(singleLine(finding.category), scope);
  const title = escapeMarkdownText(singleLine(finding.title), scope);
  const locationLink = findingLocationLink(
    finding,
    repository,
    headSha,
    baseSha,
    scope,
  );
  const verdict = complete ? `${score}/5` : "incomplete";
  const lines: string[] = [
    `**${emojiFor(finding.severity)} ${labelFor(finding.severity)} · ${category}** — ${title} · ${verdict} · [\`${headSha.slice(0, 7)}\`](${commitUrl})`,
    ``,
    escapeMarkdownText(finding.body, scope),
    ``,
    `Evidence: ${locationLink}${finding.evidence ? ` — ${escapeMarkdownText(finding.evidence, scope)}` : ""}`,
    ``,
  ];
  if (finding.suggestion) {
    lines.push(renderSuggestionBlock(finding.suggestion, scope), ``);
  }
  lines.push(
    `<details><summary>Full context</summary>`,
    ``,
    escapeMarkdownText(finding.body, scope),
    ``,
    `Category: ${category} · Side: ${finding.side} · Key: ${escapeMarkdownText(finding.key, scope)}`,
    `</details>`,
  );
  return truncatePost(lines.join("\n"));
}

/**
 * Check-run summary. The title stays machine-readable (`{score}/5` or
 * `Incomplete review`) at the call site; the summary is the same rendered
 * summary as the PR comment.
 */
export function renderCheckSummary(input: RenderReviewSummaryInput): string {
  return renderReviewSummary(input);
}
