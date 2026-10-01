# Immutable production build-only artifacts

This bounded fork release line starts at `v2026.916.1-tog.2`, commit
`6aefa649f4815ad6784a4e68a3482456bc41db6b`. It repairs the existing
`.github/workflows/docker.yml`. It does not change the runtime Dockerfile.

## Gates and command contract

Merge the CI repair into `release/tog.5-build-preparation` only after independent
review and green exact-head CI. That PR base must start at the exact tog.2 commit,
not master. Do not dispatch the unsafe baseline workflow. Do not push a release
tag to test it. The first build uses the reviewed, merged workflow ref.

The workflow has no publication option. Its dispatch inputs are `build_mode`,
`source_sha`, and `expected_source_sha`. Both SHAs must be full 40-character hex
commit IDs. They must match. No branch, tag, short SHA or shell expression is
accepted as application source. Select the workflow separately from the source:

```sh
# Verify this branch still points to the independently reviewed merged repair.
# Set SOURCE_SHA to the independently approved exact release-port commit.
# That source placeholder is not evidence that the final candidate is ready.
gh workflow run docker.yml --repo TogetherWeOwn/paperclip \
  --ref release/tog.5-build-preparation \
  -f build_mode=build-only \
  -f source_sha="$SOURCE_SHA" \
  -f expected_source_sha="$SOURCE_SHA"
```

`expected_source_sha` checks identity; it is not an approval mechanism. The source
owner must obtain the exact candidate's independent approval and green CI before
this command. Review of an application PR on master does not approve a different
cherry-picked port SHA. Fixes remain on the application's existing review card.
The builder does not depend on completion of that application work; the final
release build does depend on it.

A baseline validation can set `SOURCE_SHA` to the tog.2 commit above while using
the reviewed, merged repair branch as the workflow ref. GitHub resolves that ref
once; `github.workflow_sha` records the immutable controls revision in the run.
Label that result **baseline validation,
not the nested-wake release image**. This document does not name a final candidate
SHA or claim that an image build, publication or deployment passed.

Push/tag events use the event's immutable `github.sha`. They also build only
artifacts, never registry images. PR events run focused guards only. The release
base merge does not automatically dispatch an image build. Other legacy dispatch
workflows are not part of this contract; do not invoke `release.yml` or
`docker-cloud.yml` for this release line.

## Immutable inputs and scope

The control script is checked out from `github.workflow_sha` in `controls/`.
Application files are checked out separately in `source/` at the validated SHA.
Credentials do not remain in either Git checkout. Before building, the guards
require the real source HEAD to match, tog.2 to be an ancestor, no imported merge
ancestry, a pristine build context, and the Dockerfile to match tog.2 exactly.
No master merge, lockfile refresh, source overlay or vendor overlay is supported.

The unchanged Dockerfile installs dependencies with `--frozen-lockfile` and Cargo
with `--locked`. An outdated committed lockfile fails the build. Do not silently
refresh it to manufacture success. The provenance records the committed lockfile
and Dockerfile SHA-256. It separates application diff paths from CI-only paths.
That inventory does not approve the application diff; the source review does.

Only `production` builds. Both existing native architectures remain required:
`linux/amd64` on `ubuntu-latest` and `linux/arm64` on `ubuntu-24.04-arm`.
One failed leg makes the workflow fail even if the other artifact exists. No
QEMU fallback or architecture removal is permitted.

The full source SHA is passed as `PAPERCLIP_BUILD_COMMIT` and stamped in the OCI
revision label. The control SHA is a separate label. The image name is lowercase
and validated (`ghcr.io/togetherweown/paperclip`); its full-SHA tag is local
metadata, not a registry write. The workflow has only `contents: read`; it has no
GHCR login, package writes, shared cache import/export, cloud job, mutable alias,
channel promotion or automatic release/tag operation.

**Reproducibility boundary:** immutable source identity is not a claim of
byte-for-byte reproducibility. The unchanged tog.2 recipe fetches mutable
Docker base/frontend images, OS packages and CLI tools. Their realized image is
identified by the output checksums and OCI digests. Pinning or rewriting that
recipe is outside this CI-only repair.

## Artifact identity, provenance and access

Each successful native leg uploads an Actions artifact named:

```text
production-oci-<amd64|arm64>-<full-source-sha>-<run-id>-<run-attempt>
```

It contains:

- `production-<arch>.oci.tar`: the OCI image archive.
- `production-<arch>.oci.tar.sha256`: the checksum of that archive, not of the
  Actions ZIP wrapper.
- `production-<arch>.provenance.json`: architecture, baseline SHA, source SHA,
  workflow SHA/path, separate application/CI diff paths, lockfile/Dockerfile
  hashes, archive checksum, OCI index checksum, image manifest/config digests,
  run identity and runtime verification outcome.

Download from `https://github.com/TogetherWeOwn/paperclip/actions/runs/<run-id>`
or use the actual full artifact name:

```sh
gh run download <run-id> --repo TogetherWeOwn/paperclip \
  --name production-oci-<arch>-<source-sha>-<run-id>-<attempt> \
  --dir ./production-<arch>
cd ./production-<arch>
sha256sum --check production-<arch>.oci.tar.sha256
```

Retention is seven days. Copy any approved deliverable before expiry through
an authorized artifact handoff. No artifact exists until a leg passes.

**Digest meanings are distinct.** `archive_sha256` hashes the tar bytes.
`oci_index_sha256` hashes the archive's index JSON. `image_manifest_digest` and
`image_config_digest` identify blobs inside the OCI archive. The Actions upload
service can additionally return its ZIP artifact digest. None is evidence of a
published registry manifest; this workflow never publishes one.

Buildx exports an OCI archive and a Docker archive from the same solve. Each
native runner loads the Docker archive without pulling a registry image. The
control script requires its image/config ID to equal the OCI config digest.
The runner then executes the existing `assert-orphan-reaping.sh` against that
image's real entrypoint with networking disabled. The OCI output's architecture,
source label, workflow label, runtime commit environment and tini entrypoint
are verified before it is uploaded. The Docker archive is verification-only;
it is not uploaded as a second deliverable.

## Focused verification

```sh
python3 -m unittest discover -s scripts/ci -p 'test_immutable_docker.py' -v
# Tests require PyYAML 6.0.3. CI installs it in an isolated venv, without caching.
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 \
  -shellcheck= .github/workflows/docker.yml
```

Guards cover name normalization; absent, invalid and mismatched SHAs; default
no-push on dispatch/push/tag paths; no login/cloud/cache/aliases; exact separate
checkouts; full source stamping; frozen/pristine inputs; required native
architectures; run/attempt-scoped artifacts; OCI digest validation; and binding
the runtime test to the same OCI config. They do not prove the native build
will complete or authorize registry publication, a new tag or deployment.
