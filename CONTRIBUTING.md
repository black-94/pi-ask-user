# Contributing

See the [Development section in README.md](README.md#development) for local setup
and checks.

## Release

[`.github/workflows/publish.yml`](.github/workflows/publish.yml) uses staged npm
publishing: pushing a stable `vX.Y.Z` tag runs version checks, `npm ci`,
typechecking, tests, and a package preview, then stages
`@black942026/pi-ask-user` on npm. It does **not** publish directly or create a
GitHub Release. Prerelease tags are not supported.

### One-time setup

1. Create an npm granular access token with **Read and write (stage only)**
   permission for this package (or its scope when publishing it for the first
   time). The approving maintainer must have npm 2FA enabled.
2. Add it as the repository Actions secret **`NPM_TOKEN`** under GitHub
   **Settings → Secrets and variables → Actions**. Never commit the token to
   the repository.

### Create a release

From a clean working tree, update and commit both package manifests, then push
the commit and its tag (replace `0.1.2` with the next unused version):

```bash
npm version 0.1.2   # updates package.json + package-lock.json, commits, creates v0.1.2
git push origin HEAD
git push origin v0.1.2
```

The tag version must match `package.json` and both root version entries in
`package-lock.json`. After the workflow succeeds, review and approve the staged
package on npmjs.com, or use an npm CLI with staged publishing support
(the workflow installs npm 12):

```bash
npm stage list @black942026/pi-ask-user
npm stage view <stage-id>
npm stage approve <stage-id> --otp <code>
```

### Retry a release

Staged and published packages share the same version index. Do not rerun a
successfully staged tag: approve the existing stage, or reject it with
`npm stage reject <stage-id> --otp <code>` before rerunning. Already published
versions require a new version and tag.
