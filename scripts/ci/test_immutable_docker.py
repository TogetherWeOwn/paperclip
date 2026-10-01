import importlib.util
import io
import hashlib
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("immutable_docker", ROOT / "scripts/ci/immutable-docker.py")
controls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(controls)
SOURCE = "a" * 40
WORKFLOW = "b" * 40


class InputGuards(unittest.TestCase):
    def env(self, **changes):
        return {
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "BUILD_MODE": "build-only",
            "SOURCE_SHA": SOURCE,
            "EXPECTED_SOURCE_SHA": SOURCE,
            "WORKFLOW_SHA": WORKFLOW,
            "GITHUB_REPOSITORY": "TogetherWeOwn/paperclip",
            **changes,
        }

    def test_uppercase_registry_normalization(self):
        self.assertEqual(controls.resolve(self.env())["image"], "ghcr.io/togetherweown/paperclip")

    def test_full_uppercase_sha_is_normalized(self):
        self.assertEqual(controls.resolve(self.env(SOURCE_SHA=SOURCE.upper()))["source_sha"], SOURCE)

    def test_invalid_repository_names_fail(self):
        for value in ("", "owner/repo:latest", "owner/repo/extra", "owner/$(id)", "owner/repo\n", "OWNER/-repo"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                controls.image_name(value)

    def test_missing_short_invalid_and_injected_sha_fail(self):
        for key in ("SOURCE_SHA", "EXPECTED_SOURCE_SHA", "WORKFLOW_SHA"):
            for value in (None, "", "master", "abcdef0", "g" * 40, SOURCE + "\n", "$(id)"):
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    controls.resolve(self.env(**{key: value}))

    def test_mismatched_expected_sha_fails(self):
        with self.assertRaisesRegex(ValueError, "does not match"):
            controls.resolve(self.env(EXPECTED_SOURCE_SHA=WORKFLOW))

    def test_publish_mode_is_not_an_option(self):
        for mode in ("publish", "", "true", "build-only\n"):
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                controls.resolve(self.env(BUILD_MODE=mode))

    def test_push_uses_event_commit_not_mutable_ref_or_dispatch_inputs(self):
        result = controls.resolve(self.env(GITHUB_EVENT_NAME="push", GITHUB_SHA=WORKFLOW, SOURCE_SHA="master"))
        self.assertEqual(result["source_sha"], WORKFLOW)

    def test_push_without_immutable_commit_fails(self):
        with self.assertRaises(ValueError):
            controls.resolve(self.env(GITHUB_EVENT_NAME="push"))

    def test_pr_cannot_request_image_build(self):
        with self.assertRaises(ValueError):
            controls.resolve(self.env(GITHUB_EVENT_NAME="pull_request"))

    def test_artifact_identity_requires_arch_full_sha_run_and_attempt(self):
        self.assertEqual(controls.artifact_name("arm64", SOURCE, "123", "2"), f"production-oci-arm64-{SOURCE}-123-2")
        for args in (("386", SOURCE, "123", "1"), ("amd64", "master", "123", "1"), ("amd64", SOURCE, "../x", "1"), ("arm64", SOURCE, "123", "")):
            with self.subTest(args=args), self.assertRaises(ValueError):
                controls.artifact_name(*args)


class WorkflowGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = (ROOT / ".github/workflows/docker.yml").read_text()
        # BaseLoader preserves GitHub's `on` key rather than YAML 1.1's boolean.
        cls.workflow = yaml.load(cls.text, Loader=yaml.BaseLoader)

    def test_dispatch_contract_default_build_only(self):
        inputs = self.workflow["on"]["workflow_dispatch"]["inputs"]
        self.assertEqual(set(inputs), {"build_mode", "source_sha", "expected_source_sha"})
        self.assertEqual(inputs["build_mode"]["default"], "build-only")
        self.assertEqual(inputs["build_mode"]["options"], ["build-only"])
        for name in inputs:
            self.assertEqual(inputs[name]["required"], "true")

    def test_no_publish_cache_cloud_promotion_or_secret_path(self):
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(self.workflow["jobs"]), {"guards", "resolve", "build", "complete"})
        for forbidden in ("packages:", "contents: write", "login-action", "secrets.", "cache-from", "cache-to", "type=registry", "type=gha", "push=true", "push-by-digest", "imagetools", "docker-cloud", "type=semver", "value=latest", "promote_canary", "gh release", "git push"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.text)

    def test_pr_checks_without_images_and_push_defaults_are_guarded(self):
        self.assertEqual(self.workflow["on"]["pull_request"]["branches"], ["release/tog.5-build-preparation"])
        resolve = self.workflow["jobs"]["resolve"]
        self.assertEqual(resolve["if"], "github.event_name != 'pull_request'")
        self.assertEqual(resolve["needs"], "guards")
        self.assertEqual(self.workflow["jobs"]["build"]["needs"], "resolve")

    def test_exact_controls_and_source_checkouts(self):
        for job in self.workflow["jobs"].values():
            for step in job.get("steps", []):
                if step.get("uses", "").startswith("actions/checkout@"):
                    self.assertEqual(step["with"]["persist-credentials"], "false")
                    self.assertIn("sha", step["with"]["ref"])
        steps = self.workflow["jobs"]["build"]["steps"]
        self.assertEqual(steps[1]["with"]["ref"], "${{ needs.resolve.outputs.source_sha }}")
        self.assertEqual(steps[2]["run"], "python3 controls/scripts/ci/immutable-docker.py prepare")

    def test_untrusted_expressions_never_enter_shell(self):
        for job in self.workflow["jobs"].values():
            for step in job.get("steps", []):
                self.assertNotIn("${{", step.get("run", ""))

    def test_native_architectures_are_required_together(self):
        matrix = self.workflow["jobs"]["build"]["strategy"]["matrix"]["include"]
        self.assertEqual(matrix, [
            {"platform": "linux/amd64", "runner": "ubuntu-latest", "arch": "amd64"},
            {"platform": "linux/arm64", "runner": "ubuntu-24.04-arm", "arch": "arm64"},
        ])
        self.assertEqual(self.workflow["jobs"]["complete"]["needs"], ["resolve", "build"])

    def test_production_only_exports_and_source_stamp(self):
        build = next(s for s in self.workflow["jobs"]["build"]["steps"] if s.get("uses", "").startswith("docker/build-push-action@"))["with"]
        self.assertEqual(build["target"], "production")
        self.assertEqual(build["push"], "false")
        self.assertEqual(build["context"], "source")
        self.assertEqual(build["file"], "source/Dockerfile")
        self.assertEqual(build["provenance"], "false")
        self.assertEqual(build["sbom"], "false")
        self.assertIn("PAPERCLIP_BUILD_COMMIT=${{ needs.resolve.outputs.source_sha }}", build["build-args"])
        self.assertIn("type=oci,dest=", build["outputs"])
        self.assertIn("type=docker,dest=", build["outputs"])
        self.assertNotIn("type=image", build["outputs"])

    def test_artifact_provenance_and_offline_runtime_checks_are_retained(self):
        steps = self.workflow["jobs"]["build"]["steps"]
        upload = next(s for s in steps if s.get("uses", "").startswith("actions/upload-artifact@"))["with"]
        self.assertEqual(upload["name"], "production-oci-${{ matrix.arch }}-${{ needs.resolve.outputs.source_sha }}-${{ github.run_id }}-${{ github.run_attempt }}")
        self.assertIn(".oci.tar.sha256", upload["path"])
        self.assertIn(".provenance.json", upload["path"])
        self.assertEqual(upload["if-no-files-found"], "error")
        self.assertIn("--pull never --network none", self.text)
        self.assertIn("controls/scripts/assert-orphan-reaping.sh", self.text)
        self.assertNotIn("resolution-only", self.text)
        self.assertNotIn("no-frozen-lockfile", self.text)


class SourceGuards(unittest.TestCase):
    def source(self, head=SOURCE, commits=SOURCE + " " + controls.BASELINE, diff="", status=""):
        def fake_git(root, *args):
            if args[0] == "rev-parse":
                return head
            if args[0] == "rev-list":
                return commits
            if args[0] == "status":
                return status
            if args[0] == "diff" and "--name-only" in args:
                return ".github/workflows/docker.yml\nserver/src/services/heartbeat.ts"
            return diff
        return patch.object(controls, "git", side_effect=fake_git)

    def run_source(self):
        with patch.object(controls.subprocess, "run"), patch.object(controls, "file_sha", return_value="c" * 64):
            return controls.source_inputs(Path("source"), SOURCE)

    def test_application_and_ci_diffs_recorded_separately(self):
        with self.source():
            result = self.run_source()
        self.assertEqual(result["application_diff_paths"], ["server/src/services/heartbeat.ts"])
        self.assertEqual(result["ci_only_diff_paths"], [".github/workflows/docker.yml"])
        self.assertEqual(result["lockfile"]["policy"], "frozen-no-refresh")

    def test_wrong_checkout_master_merge_recipe_drift_and_lockfile_mutation_fail(self):
        for kwargs in ({"head": WORKFLOW}, {"commits": SOURCE + " " + controls.BASELINE + " " + WORKFLOW}, {"diff": "changed Dockerfile"}, {"status": " M pnpm-lock.yaml"}):
            with self.subTest(kwargs=kwargs), self.source(**kwargs), self.assertRaises(ValueError):
                self.run_source()


class OciGuards(unittest.TestCase):
    def archive(self, directory, arch="amd64", revision=SOURCE, stamp=SOURCE, workflow=WORKFLOW, images=1, corrupt=False):
        blobs = {}
        def descriptor(value):
            raw = json.dumps(value).encode()
            digest = hashlib.sha256(raw).hexdigest()
            blobs["blobs/sha256/" + digest] = raw
            return {"digest": "sha256:" + digest, "size": len(raw)}
        config = descriptor({"architecture": arch, "os": "linux", "config": {
            "Labels": {"org.opencontainers.image.revision": revision, "io.github.togetherweown.workflow-sha": workflow},
            "Env": ["PAPERCLIP_BUILD_COMMIT=" + stamp], "Entrypoint": ["/usr/bin/tini", "--", "docker-entrypoint.sh"],
        }})
        manifest = descriptor({"schemaVersion": 2, "config": config, "layers": []})
        index = {"schemaVersion": 2, "manifests": [manifest] * images}
        blobs["index.json"] = json.dumps(index).encode()
        if corrupt:
            blobs["blobs/sha256/" + manifest["digest"].split(":")[1]] = b"{}"
        path = Path(directory) / "image.tar"
        with tarfile.open(path, "w") as archive:
            for name, raw in blobs.items():
                info = tarfile.TarInfo(name)
                info.size = len(raw)
                archive.addfile(info, io.BytesIO(raw))
        return path, config["digest"], manifest["digest"]

    def test_real_oci_config_and_image_digest_not_artifact_checksum(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, config, manifest = self.archive(tmp)
            result = controls.oci_metadata(path, "amd64", SOURCE, WORKFLOW)
            self.assertEqual(result["image_config_digest"], config)
            self.assertEqual(result["image_manifest_digest"], manifest)
            self.assertNotEqual(controls.file_sha(path), manifest.removeprefix("sha256:"))

    def test_wrong_arch_source_stamp_workflow_ambiguous_or_corrupt_output_fail(self):
        for kwargs in ({"arch": "arm64"}, {"revision": WORKFLOW}, {"stamp": WORKFLOW}, {"workflow": SOURCE}, {"images": 2}, {"images": 0}, {"corrupt": True}):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as tmp:
                path, _, _ = self.archive(tmp, **kwargs)
                with self.assertRaises(ValueError):
                    controls.oci_metadata(path, "amd64", SOURCE, WORKFLOW)

    def test_loaded_runtime_must_match_oci_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            path, config, _ = self.archive(tmp)
            controls.verify_runtime(path, [{"Id": config, "Architecture": "amd64", "Os": "linux"}], "amd64", SOURCE)
            with self.assertRaises(ValueError):
                controls.verify_runtime(path, [{"Id": "sha256:" + "d" * 64, "Architecture": "amd64", "Os": "linux"}], "amd64", SOURCE)


if __name__ == "__main__":
    unittest.main()
