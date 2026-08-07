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

## Current reality: manual, OTP-gated publish

There is **no automated npm publish workflow** in `.github/workflows/` (CI there only
runs lint/typecheck/build/test) and **npm Trusted Publishing is not configured** for this
package. Publishing is a manual `npm publish` from a maintainer's machine, gated by npm's
own OTP (one-time password) 2FA prompt. This document describes the process as it
actually works today, not an aspirational automated pipeline — if Trusted Publishing or a
CI-driven publish workflow is set up later, this doc should be updated to match, not the
other way around.

## The 8 steps

1. **Update version + changelog.** Bump `version` in every `packages/*/package.json` and
   `publish/spec-lane/package.json` to the same new SemVer value, and add a new
   `CHANGELOG.md` section for it (move anything sitting in `## Unreleased` into the new
   version's own section, or add fresh entries directly).
2. **Open a PR, wait for CI green.** Never publish from a branch CI hasn't validated.
3. **Merge to `main`.** The merge commit is now the release commit — remember its SHA
   (`git rev-parse HEAD` right after merging, or read it off the merge commit in
   `git log`).
4. **Publish to npm, manually, from that exact commit.** Check out the release commit
   clean (`git checkout main && git pull`), run the clean build the publish bundle needs
   (`pnpm install && pnpm run build:publish`), then `cd publish/spec-lane && npm publish`
   — this prompts for your npm OTP. Do not publish from a dirty tree or a commit other
   than the one CI just validated.
5. **Verify the registry.** `npm view spec-lane version` and
   `npm view spec-lane dist-tags --json` should show the new version as `latest`.
6. **Create an immutable `vX.Y.Z` tag on the release commit.** `git tag -a vX.Y.Z <sha>
   -m "spec-lane vX.Y.Z"` then `git push origin vX.Y.Z`. Once pushed, this tag is
   immutable — never move it to a different commit, even to "fix" a mistake. If the tag
   is wrong, ship a new patch version instead.
7. **Create a GitHub Release from that same commit/tag.** Title it `spec-lane vX.Y.Z`.
   Release notes should distinguish `Added`/`Changed`/`Fixed`/`Known limitations`/
   `Verification` where relevant, and should carry the same pre-1.0 breaking-change
   caveat this doc's own header states — don't imply more stability than the project
   actually has.
8. **Clean-room verify.** From a fresh temp directory (not this checkout):
   `npm install -g spec-lane && lane --version` should report the new version with no
   local workspace state involved.

## Historical releases

Historical releases (0.1.0 through 0.3.1) are documented in `CHANGELOG.md`; they do not
have a matching git tag or GitHub Release. Retroactively fabricating a tag for one of
those without being able to verify it points at the *exact* commit that was actually
published from would be worse than not having one — an incorrect historical tag is a
trap for anyone who later trusts it. Formal GitHub Release / tag synchronization (the 8
steps above) starts with the next version published after this policy was adopted.
