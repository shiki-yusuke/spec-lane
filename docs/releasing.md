# Release policy

`spec-lane`/`lane` is pre-1.0 (alpha). Breaking changes between minor releases are
expected and are not accompanied by a deprecation period (see `CHANGELOG.md`'s own
header note).

## Principle

```text
npm release == same SemVer git tag == GitHub Release
```

`spec-lane@0.3.2`, the git tag `v0.3.2`, and a GitHub Release titled `spec-lane v0.3.2`
are one set, all pointing at the exact same commit. Never let the npm release, the tag,
and the GitHub Release drift onto different commits — a maintainer or a downstream
consumer diffing `v0.3.2`'s tree against what's actually on the registry needs them to
agree byte-for-byte.

## How publishing works: tag push -> GitHub Actions (npm Trusted Publishing)

Publishing runs in `.github/workflows/release.yml`, triggered by pushing a `vX.Y.Z` tag.
It authenticates to npm with **Trusted Publishing** (GitHub's OIDC token exchanged for a
short-lived publish credential), so no npm token or OTP is involved and the published
tarball carries an npm provenance attestation. The npm-side Trusted Publisher is
registered for repository `shiki-yusuke/spec-lane`, workflow `release.yml`, environment
`npm`, with **Allow `npm publish`** enabled (the workflow publishes directly; without it
only `npm stage publish` is permitted and the publish job fails). These fields cannot be
edited once the connection exists — delete it and create a new one to change them. The
GitHub environment `npm` only accepts deployments from `v*` tags, and `id-token: write` is
granted to the publish job only.

The workflow's jobs:

- **Build and check** — refuses a tag that doesn't equal `v` + `publish/spec-lane`'s
  version or whose commit isn't on `main`; runs lint / build / typecheck / test and
  `build:publish`; packs the tarball, records its SHA-256, installs it into an empty
  directory and checks `lane --version`. `workflow_dispatch` runs this job alone, as a
  dry run.
- **Publish to npm** (environment `npm`) — publishes that exact tarball after re-checking
  its SHA-256.
- **GitHub Release** — creates `spec-lane vX.Y.Z` from the version's `CHANGELOG.md`
  section if no release exists yet (a release written by hand first keeps its notes), and
  attaches the tarball and `SHA256SUMS`.

## The steps

1. **Update version + changelog.** Bump `version` in every `packages/*/package.json` and
   `publish/spec-lane/package.json` to the same new SemVer value, and add a new
   `CHANGELOG.md` section for it (move anything sitting in `## Unreleased` into the new
   version's own section, or add fresh entries directly).

   The version also appears in one **source constant** that no `package.json` edit touches:
   `LANE_VERSION` in `packages/cli/src/version.ts` — what `lane --version` prints, what
   `advance` records into a done overlay, and what `calibrate` / `usage-import` compare an
   existing overlay's version against before re-writing it (issue #50).
   `packages/cli/test/version-consistency.test.ts` compares it (and every `package.json`)
   against the declared version and forbids a literal fallback creeping back in, so this is
   a red test rather than something to remember — but bump it in the same edit.
2. **Open a PR, wait for CI green.** Never publish from a branch CI hasn't validated.
3. **Merge to `main`.** The merge commit is now the release commit — remember its SHA
   (`git rev-parse HEAD` right after merging, or read it off the merge commit in
   `git log`).
4. **Push an immutable `vX.Y.Z` tag on the release commit.** `git tag -a vX.Y.Z <sha>
   -m "spec-lane vX.Y.Z"` then `git push origin vX.Y.Z`. This starts `release.yml`. Once
   pushed, the tag is immutable — never move it to a different commit, even to "fix" a
   mistake. If the tag or the published package is wrong, ship a new patch version
   instead. If the workflow fails *before* publishing, fix the cause on `main` and release
   a new patch version rather than re-pointing the tag.
5. **Watch the run.** `gh run watch` on the `Release` run; all three jobs should succeed.
6. **Verify the registry.** `npm view spec-lane version` and
   `npm view spec-lane dist-tags --json` should show the new version as `latest`. The
   package is published from the packed tarball, so the registry carries no `gitHead`;
   the link back to the release commit is the provenance attestation instead:
   `npm view spec-lane@X.Y.Z dist.attestations --json` should list a provenance
   predicate, and the package page's *Provenance* section should name this repository,
   `release.yml`, and the release commit. A just-published version can take a few minutes
   to appear everywhere (a tarball 404 right after publish has cleared within minutes).
7. **Check the GitHub Release** the workflow created or updated (title `spec-lane vX.Y.Z`,
   tarball and `SHA256SUMS` attached). Release notes should distinguish `Added`/`Changed`/
   `Fixed`/`Known limitations`/`Verification` where relevant, and should carry the same
   pre-1.0 breaking-change caveat this doc's own header states — edit the generated notes
   if the CHANGELOG section doesn't already.
8. **Clean-room verify.** From a fresh temp directory (not this checkout):
   `npm install -g spec-lane && lane --version` should report the new version with no
   local workspace state involved.

### Fallback: manual publish

If the tag's run passed **Build and check** but **Publish to npm** failed (e.g. the Trusted
Publisher configuration is broken), publish the tarball that run already built and
checked — never a local rebuild, which would not be byte-identical to what was verified:

```sh
gh run download <run-id> --name release-tarball --dir release
(cd release && sha256sum -c SHA256SUMS)   # macOS: shasum -a 256 -c SHA256SUMS
npm publish release/spec-lane-X.Y.Z.tgz --access public   # prompts for the npm OTP
```

The tag is already pushed, so don't push it again; create the GitHub Release by hand
(`gh release create vX.Y.Z --verify-tag --title "spec-lane vX.Y.Z" --notes-file <notes>
release/*.tgz release/SHA256SUMS`). A manual publish has no provenance attestation. If
**Build and check** itself failed, nothing was published: fix the cause on `main` and
release a new patch version.

## Historical releases

Historical releases (0.1.0 through 0.3.1) are documented in `CHANGELOG.md`; they do not
have a matching git tag or GitHub Release. Retroactively fabricating a tag for one of
those without being able to verify it points at the *exact* commit that was actually
published from would be worse than not having one — an incorrect historical tag is a
trap for anyone who later trusts it. Formal GitHub Release / tag synchronization (the 8
steps above) starts with the next version published after this policy was adopted.
