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
  sourceRevision: string;
  imageReference: string;
  /** Expected OCI digest, `sha256:<64 lowercase hex>`. */
  expectedDigest: string;
};

export type VerifySourceImageAttestationResult =
  | { ok: true; digest: string; verifiedAtValidationTime: true }
  | {
      ok: false;
      errorCode: "mutable_tag_refused" | "digest_mismatch" | "digest_unparseable";
    };

const EXPECTED_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function refuse(
  errorCode: Extract<
    VerifySourceImageAttestationResult,
    { ok: false }
  >["errorCode"],
): VerifySourceImageAttestationResult {
  return { ok: false, errorCode };
}

export function verifySourceImageAttestation(
  input: VerifySourceImageAttestationInput,
): VerifySourceImageAttestationResult {
  const expectedDigest =
    input !== null && typeof input === "object" ? input.expectedDigest : undefined;
  if (
    typeof expectedDigest !== "string" ||
    !EXPECTED_DIGEST_PATTERN.test(expectedDigest)
  ) {
    return refuse("digest_unparseable");
  }

  const imageReference =
    input !== null && typeof input === "object" ? input.imageReference : undefined;
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

  if (!EXPECTED_DIGEST_PATTERN.test(digestPart)) {
    return refuse("digest_unparseable");
  }

  if (digestPart !== expectedDigest) {
    return refuse("digest_mismatch");
  }

  return {
    ok: true,
    digest: expectedDigest,
    verifiedAtValidationTime: true,
  };
}
