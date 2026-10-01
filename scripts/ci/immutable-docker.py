#!/usr/bin/env python3
"""Build-only release controls. No registry credentials or publication operations."""

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile

BASELINE = "6aefa649f4815ad6784a4e68a3482456bc41db6b"
SHA = re.compile(r"[0-9a-fA-F]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
COMPONENT = r"[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*"
REPOSITORY = re.compile(rf"{COMPONENT}/{COMPONENT}\Z")
ARCHES = {"amd64", "arm64"}


def full_sha(value):
    if not isinstance(value, str) or not SHA.fullmatch(value):
        raise ValueError("A full immutable 40-character source/workflow SHA is required")
    return value.lower()


def image_name(repository):
    name = repository.lower()
    if not REPOSITORY.fullmatch(name) or len("ghcr.io/" + name) > 255:
        raise ValueError("Invalid registry repository name")
    return "ghcr.io/" + name


def resolve(env):
    event = env.get("GITHUB_EVENT_NAME")
    if event == "workflow_dispatch":
        if env.get("BUILD_MODE", "build-only") != "build-only":
            raise ValueError("Only build-only mode is supported")
        source = full_sha(env.get("SOURCE_SHA"))
        expected = full_sha(env.get("EXPECTED_SOURCE_SHA"))
    elif event == "push":
        # The push event itself supplies the expected immutable commit. There
        # is no mutable branch resolution, even when the branch advances later.
        source = expected = full_sha(env.get("GITHUB_SHA"))
    else:
        raise ValueError("Images may only build on push or workflow_dispatch")
    if source != expected:
        raise ValueError("source_sha does not match expected_source_sha")
    return {
        "source_sha": source,
        "workflow_sha": full_sha(env.get("WORKFLOW_SHA")),
        "image": image_name(env.get("GITHUB_REPOSITORY", "")),
    }


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def file_sha(path):
    with open(path, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def source_inputs(root, source_sha):
    if git(root, "rev-parse", "HEAD") != full_sha(source_sha):
        raise ValueError("Checkout HEAD differs from expected source SHA")
    subprocess.run(["git", "-C", str(root), "merge-base", "--is-ancestor", BASELINE, source_sha], check=True)
    commits = git(root, "rev-list", "--parents", f"{BASELINE}..{source_sha}").splitlines()
    if any(len(commit.split()) != 2 for commit in commits):
        raise ValueError("Release source must not import merge ancestry")
    if git(root, "diff", BASELINE, source_sha, "--", "Dockerfile"):
        raise ValueError("Runtime Dockerfile recipe differs from the tog.2 baseline")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Build context is not pristine; lockfile refresh is forbidden")
    paths = git(root, "diff", "--name-only", BASELINE, source_sha).splitlines()
    ci_only = [p for p in paths if p.startswith((".github/", "scripts/ci/")) or p == "doc/IMMUTABLE-DOCKER-BUILDS.md"]
    return {
        "baseline_sha": BASELINE,
        "application_diff_paths": [p for p in paths if p not in ci_only],
        "ci_only_diff_paths": ci_only,
        "dockerfile_sha256": file_sha(root / "Dockerfile"),
        "lockfile": {"policy": "frozen-no-refresh", "sha256": file_sha(root / "pnpm-lock.yaml")},
    }


def read_json(archive, name):
    member = archive.getmember(name)
    if not member.isfile() or member.size > 1024 * 1024:
        raise ValueError("Invalid or oversized OCI metadata member")
    return archive.extractfile(member).read()


def blob(archive, descriptor):
    digest = descriptor.get("digest", "")
    if not DIGEST.fullmatch(digest):
        raise ValueError("Invalid OCI digest")
    raw = read_json(archive, "blobs/sha256/" + digest.split(":")[1])
    if len(raw) != descriptor.get("size") or "sha256:" + hashlib.sha256(raw).hexdigest() != digest:
        raise ValueError("OCI metadata digest or size mismatch")
    return json.loads(raw)


def oci_metadata(path, arch, source_sha, workflow_sha=None):
    if arch not in ARCHES:
        raise ValueError("Unsupported architecture")
    with tarfile.open(path, "r:") as archive:
        index_raw = read_json(archive, "index.json")
        index = json.loads(index_raw)
        # Buildx can wrap a single native manifest in another index. We disable
        # attestations and refuse ambiguous/multi-platform output for each leg.
        for _ in range(4):
            manifests = index.get("manifests", [])
            if len(manifests) != 1:
                raise ValueError("Each native archive must contain exactly one image")
            descriptor = manifests[0]
            manifest = blob(archive, descriptor)
            if "manifests" not in manifest:
                break
            index = manifest
        else:
            raise ValueError("OCI index nesting limit exceeded")
        config_descriptor = manifest["config"]
        config = blob(archive, config_descriptor)
        if config.get("architecture") != arch or config.get("os") != "linux":
            raise ValueError("OCI config architecture does not match the native runner")
        settings = config.get("config", {})
        labels = settings.get("Labels", {})
        if labels.get("org.opencontainers.image.revision") != full_sha(source_sha):
            raise ValueError("OCI source revision label mismatch")
        if workflow_sha is not None and labels.get("io.github.togetherweown.workflow-sha") != full_sha(workflow_sha):
            raise ValueError("OCI workflow revision label mismatch")
        if "PAPERCLIP_BUILD_COMMIT=" + full_sha(source_sha) not in settings.get("Env", []):
            raise ValueError("Runtime build commit stamp mismatch")
        if settings.get("Entrypoint", [None])[0] != "/usr/bin/tini":
            raise ValueError("Production init entrypoint missing")
        return {
            "oci_index_sha256": hashlib.sha256(index_raw).hexdigest(),
            "image_manifest_digest": descriptor["digest"],
            "image_config_digest": config_descriptor["digest"],
        }


def verify_runtime(oci, runtime, arch, source_sha):
    metadata = oci_metadata(oci, arch, source_sha)
    if len(runtime) != 1 or runtime[0].get("Id") != metadata["image_config_digest"]:
        raise ValueError("Loaded runtime image is not the OCI config")
    if runtime[0].get("Architecture") != arch or runtime[0].get("Os") != "linux":
        raise ValueError("Loaded runtime image architecture mismatch")
    return metadata


def artifact_name(arch, source_sha, run_id, attempt):
    if arch not in ARCHES or not re.fullmatch(r"[0-9]+", run_id) or not re.fullmatch(r"[0-9]+", attempt):
        raise ValueError("Invalid run-scoped artifact identity")
    return f"production-oci-{arch}-{full_sha(source_sha)}-{run_id}-{attempt}"


def main(command):
    env = os.environ
    if command == "resolve":
        outputs = resolve(env)
        with open(env["GITHUB_OUTPUT"], "a") as stream:
            for key, value in outputs.items():
                stream.write(f"{key}={value}\n")
        print(json.dumps(outputs, indent=2))
        return
    temp = Path(env["RUNNER_TEMP"])
    arch = env.get("ARCH", "")
    if arch not in ARCHES:
        raise ValueError("Unsupported architecture")
    source = full_sha(env["SOURCE_SHA"])
    oci = temp / f"production-{arch}.oci.tar"
    if command == "verify-runtime":
        verify_runtime(oci, json.loads((temp / "runtime-image.json").read_text()), arch, source)
        return
    workflow = full_sha(env["WORKFLOW_SHA"])
    if git(Path("controls"), "rev-parse", "HEAD") != workflow:
        raise ValueError("Build controls checkout differs from workflow SHA")
    inputs = source_inputs(Path("source"), source)
    provenance_path = temp / f"production-{arch}.provenance.json"
    common = {
        **inputs,
        "source_sha": source,
        "workflow_sha": workflow,
        "workflow_path": ".github/workflows/docker.yml",
        "platform": "linux/" + arch,
        "target": "production",
        "image_name": image_name(env["GITHUB_REPOSITORY"]),
        "published": False,
        "shared_cache": False,
    }
    if command == "prepare":
        # Save this before BuildKit executes; record rechecks the pristine tree.
        provenance_path.write_text(json.dumps(common, indent=2) + "\n")
    elif command == "record":
        if json.loads(provenance_path.read_text()) != common:
            raise ValueError("Source/build inputs changed during the build")
        metadata = oci_metadata(oci, arch, source, workflow)
        checksum = file_sha(oci)
        (temp / f"production-{arch}.oci.tar.sha256").write_text(f"{checksum}  {oci.name}\n")
        name = artifact_name(arch, source, env["GITHUB_RUN_ID"], env["GITHUB_RUN_ATTEMPT"])
        provenance = {
            **common, **metadata,
            "archive_sha256": checksum,
            "archive_file": oci.name,
            "artifact_name": name,
            "run_id": env["GITHUB_RUN_ID"],
            "run_attempt": env["GITHUB_RUN_ATTEMPT"],
            "run_url": f"{env['GITHUB_SERVER_URL']}/{env['GITHUB_REPOSITORY']}/actions/runs/{env['GITHUB_RUN_ID']}",
            "orphan_reaping": "passed-on-matching-native-config",
            "recipe_limitations": "Unchanged tog.2 recipe uses mutable base/frontend/tool downloads; source identity is immutable, byte reproducibility is not claimed.",
        }
        provenance_path.write_text(json.dumps(provenance, indent=2) + "\n")
        with open(env["GITHUB_STEP_SUMMARY"], "a") as stream:
            stream.write(f"### {name}\n\n```json\n{json.dumps(provenance, indent=2)}\n```\n\nDigests describe the local OCI image, not a published registry manifest.\n")
    else:
        raise ValueError("Unknown build control command")


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except (ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Build guard failed: {error}", file=sys.stderr)
        sys.exit(1)
