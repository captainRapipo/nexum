# Code signing (SignPath Foundation)

Windows **Smart App Control** and **SmartScreen** block or warn on unsigned executables. Nexum is signed through
[SignPath Foundation](https://signpath.org), which provides free code-signing certificates to open-source projects.

## How releases are signed

1. A maintainer pushes a tag `vX.Y.Z`.
2. The `build` job in `.github/workflows/build.yml` compiles everything from source on a clean GitHub-hosted runner and
   uploads two unsigned artifacts: `nexum-installers-unsigned` (NSIS `.exe` + `.msi`) and `nexum-portable-unsigned`
   (`Nexum.exe`, `nexum-agent.exe`, `LICENSE`).
3. The `sign` job submits both artifacts to SignPath. SignPath verifies they came from this repository's workflow
   (origin verification), a maintainer approves the request, and the signed files are returned.
4. Signed files are attached to a **draft** GitHub release, reviewed, then published.

Unsigned CI artifacts from regular commits are for testing only.

## One-time setup (maintainer)

1. Apply at <https://signpath.org/apply> with this repository URL.
2. After approval, in the SignPath project create:
   * signing policy slug **`release-signing`** (manual approval required)
   * artifact configuration **`installers`**: a zip containing `*.exe` / `*.msi` → sign each with Authenticode
   * artifact configuration **`portable`**: a zip containing `Nexum.exe` and `nexum-agent.exe` → sign each with Authenticode
3. Install the SignPath GitHub App on the repository (enables origin verification).
4. In GitHub → Settings → Secrets and variables → Actions:
   * secret `SIGNPATH_API_TOKEN` (a SignPath CI user token)
   * variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`
5. Enable multi-factor authentication on both GitHub and SignPath accounts (SignPath Foundation requirement).

## Roles

| Role | People |
| --- | --- |
| Committers & reviewers | @captainRapipo |
| Approvers | @captainRapipo |
