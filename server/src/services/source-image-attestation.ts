/**
 * Source-to-image attestation check.
 *
 * DIGEST PINNING, NOT PROVENANCE: a success result proves only that two
 * caller-supplied digest strings matched at validation time. It does not
 * prove what source built an image, what is deployed, or that any
 * registry/signature check ran. There is deliberately no registry allowlist:
 * any registry validates when the digests match.
 *
 * Pure, side-effect-free string comparison. It performs no registry access,
 * no signature verification, and no deployment lookup.
 */

export type VerifySourceImageAttestationInput = {
  /** Source commit id bound to the attestation: 40-64 lowercase hex. */
  sourceRevision: string;
  imageReference: string;
  /** Expected OCI digest, `sha256:<64 lowercase hex>`. */
  expectedDigest: string;
};

export type VerifySourceImageAttestationResult =
  | {
      ok: true;
      digest: string;
      sourceRevision: string;
      verifiedAtValidationTime: true;
    }
  | {
      ok: false;
      errorCode:
        | "mutable_tag_refused"
        | "digest_mismatch"
        | "digest_unparseable"
        | "revision_unparseable"
        | "repository_unparseable";
    };

const EXPECTED_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40,64}$/;
const REPOSITORY_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const HOST_COMPONENT_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function refuse(
  errorCode: Extract<
    VerifySourceImageAttestationResult,
    { ok: false }
  >["errorCode"],
): VerifySourceImageAttestationResult {
  return { ok: false, errorCode };
}

function hasRejectedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * OCI repository grammar: optional host[:port] first component, path
 * components `[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*` separated by single `/`.
 * Rejects whitespace/control characters, URL schemes, and empty components
 * (leading/trailing/double slashes) so a caller-kept reference string cannot
 * pass as an exact binding with injection-sensitive content.
 */
function isValidRepository(repository: string): boolean {
  if (repository.length === 0 || repository.length > 255) {
    return false;
  }
  if (/\s/.test(repository) || hasRejectedControlCharacter(repository)) {
    return false;
  }
  if (repository.includes("://")) {
    return false;
  }
  if (
    repository.startsWith("/") ||
    repository.endsWith("/") ||
    repository.includes("//")
  ) {
    return false;
  }
  const parts = repository.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const component = parts[index] as string;
    if (component.length === 0) {
      return false;
    }
    if (index === 0 && parts.length > 1) {
      const colonIndex = component.indexOf(":");
      if (colonIndex !== -1) {
        const host = component.slice(0, colonIndex);
        const port = component.slice(colonIndex + 1);
        if (
          host.length === 0 ||
          !HOST_COMPONENT_PATTERN.test(host.toLowerCase())
        ) {
          return false;
        }
        if (!/^[0-9]+$/.test(port)) {
          return false;
        }
        continue;
      }
    }
    if (component.includes(":")) {
      return false;
    }
    if (!REPOSITORY_COMPONENT_PATTERN.test(component.toLowerCase())) {
      return false;
    }
  }
  return true;
}

export function verifySourceImageAttestation(
  input: VerifySourceImageAttestationInput,
): VerifySourceImageAttestationResult {
  const sourceRevision =
    input !== null && typeof input === "object"
      ? input.sourceRevision
      : undefined;
  if (
    typeof sourceRevision !== "string" ||
    !SOURCE_REVISION_PATTERN.test(sourceRevision)
  ) {
    return refuse("revision_unparseable");
  }

  const expectedDigest =
    input !== null && typeof input === "object"
      ? input.expectedDigest
      : undefined;
  if (
    typeof expectedDigest !== "string" ||
    !EXPECTED_DIGEST_PATTERN.test(expectedDigest)
  ) {
    return refuse("digest_unparseable");
  }

  const imageReference =
    input !== null && typeof input === "object"
      ? input.imageReference
      : undefined;
  if (typeof imageReference !== "string" || imageReference.length === 0) {
    return refuse("mutable_tag_refused");
  }

  // No digest separator: a bare repository or `<repository>:<tag>` reference
  // carries no digest binding and is refused as mutable. A digest-looking
  // fragment embedded without the `@` separator is malformed, not a tag.
  if (!imageReference.includes("@")) {
    if (imageReference.includes("sha256:")) {
      return refuse("digest_unparseable");
    }
    return refuse("mutable_tag_refused");
  }

  const parts = imageReference.split("@");
  if (parts.length !== 2) {
    return refuse("digest_unparseable");
  }
  const [repository, digestPart] = parts as [string, string];
  if (repository.length === 0) {
    return refuse("digest_unparseable");
  }
  // Mutability wins over the digest binding: a tag qualifier on the
  // repository name (the colon after the last slash, so registry ports are
  // not mistaken for tags) refuses even when a digest is present.
  const repositoryName = repository.slice(repository.lastIndexOf("/") + 1);
  if (repositoryName.includes(":")) {
    return refuse("mutable_tag_refused");
  }

  if (!isValidRepository(repository)) {
    return refuse("repository_unparseable");
  }

  if (!EXPECTED_DIGEST_PATTERN.test(digestPart)) {
    return refuse("digest_unparseable");
  }

  if (digestPart !== expectedDigest) {
    return refuse("digest_mismatch");
  }

  return {
    ok: true,
    digest: expectedDigest,
    sourceRevision,
    verifiedAtValidationTime: true,
  };
}
