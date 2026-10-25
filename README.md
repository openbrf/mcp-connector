# MCP Connector for Open BRF: releases

The MCP Connector is an [Open BRF](https://github.com/openbrf/openbrf) plugin
that lets an MCP client, such as a chat assistant, act as a signed-in member of
a housing cooperative, through the actions the instance's administrator offers
to connected apps.

It is a paid module from Apteo AB. Its source is not in this repository. This
is a **release-only repository**, as Open BRF
[ADR 0044](https://github.com/openbrf/openbrf/blob/main/docs/adr/0044-a-listing-released-from-a-repository-without-its-source.md)
describes: it holds the release workflow, and each release is built from the
commit of the private source that `source.json`, at this repository's root,
pins.

## Installing

An instance installs the connector from the
[Open BRF catalog](https://github.com/openbrf/catalog) once it is listed
there. Each version's tarball is an asset of this repository's
[releases](https://github.com/openbrf/mcp-connector/releases), and the board
enters the instance's licence on the instance's licence screen. No version has
been released yet.

## What a release proves

- **The tarball** is attested by this repository's
  [release workflow](.github/workflows/release.yml), in a run on the release's
  tag. Check it with
  `gh attestation verify <file>.tgz --repo openbrf/mcp-connector --source-ref refs/tags/v<version>`.
- **The source** is named by the `source.json` packed in the tarball, a copy of
  this repository's `source.json` at the tagged commit. It is Apteo's
  statement of the commit the tarball was built from, kept in this
  repository's public history. The workflow builds only a commit on the main
  branch of apteoab/openbrf-modules. Whoever can read the source can check out
  that commit and build it with the same steps.

## Releasing

1. Open a pull request that moves `source.json` to the commit of
   apteoab/openbrf-modules to release:

   ```json
   {
     "repository": "https://github.com/apteoab/openbrf-modules",
     "commit": "<full commit id>"
   }
   ```

2. Merge it. Make sure no earlier release run is still waiting for approval or
   building: a job reads its environment secrets when it starts, so a key
   changed under a run that has sealed its archive leaves that run's build
   unable to unseal it. Then set a fresh `SOURCE_ARCHIVE_KEY`, the same in both
   release environments. The subshell stops at the first failing command:

   ```sh
   (
     set -eu
     key=$(openssl rand -base64 48)
     for environment in release-source release-build; do
       printf '%s' "$key" |
         gh secret set SOURCE_ARCHIVE_KEY --repo openbrf/mcp-connector --env "$environment"
     done
   )
   ```

   Confirm that both environments list `SOURCE_ARCHIVE_KEY` with an updated
   time of just now before you push the tag:

   ```sh
   for environment in release-source release-build; do
     gh secret list --repo openbrf/mcp-connector --env "$environment"
   done
   ```

3. Push the tag `v<version>` from `main` while `source.json` there still pins
   that commit. The version is the one the pinned commit's package states.
4. Approve the run twice: in `release-source` before it fetches the source,
   and in `release-build` before it builds it.

The workflow refuses a tag that is not on `main`, whose `source.json` is not
`main`'s, or that does not match the version, and a pin that is not on the
main branch of apteoab/openbrf-modules. It fetches the pinned commit in a job
that runs none of the source's code, then runs the connector's typecheck and
tests in a job of its own, packs it with the pin copied in unchanged, attests
the tarball and publishes the release. Its job summary gives the sha512 and
size for the catalog entry.

The run logs of this repository are public, so the output of the source's
dependency install, typecheck, tests and build stays out of them. A failed
release says which step failed; running that step in a checkout of the pinned
commit shows why. The source passes from one job to the next only encrypted,
and only the root files and the connector's own directory: the job that runs
the source's code never holds the other modules. The run deletes every
artifact it made when it ends. To retry a run that failed before it published
the release, use **Re-run all jobs**: **Re-run failed jobs** does not run the
jobs that made the artifacts again, so the retried jobs find them deleted.

The workflow relies on these repository settings:

- releases are immutable;
- a tag ruleset lets only the maintainers create a `v*` tag, and nobody move or
  delete one;
- a branch ruleset on `main` requires a pull request approved by someone other
  than its author, and refuses force pushes and deletion;
- two environments, `release-source` and `release-build`, each allow only
  `v*` tags, and a maintainer approves each run's job in each:
  - `release-source` holds `SOURCE_DEPLOY_KEY`, a read-only deploy key on
    apteoab/openbrf-modules that reads every module in that repository, not
    only the connector, and `SOURCE_ARCHIVE_KEY`;
  - `release-build` holds `SOURCE_ARCHIVE_KEY` alone. Its job runs the
    source's install, tests and build, so it must never hold the deploy key;
- `SOURCE_ARCHIVE_KEY` is a random key of at least 32 characters that
  encrypts the source the run hands from one job to the next. Both
  environments hold the same one, set afresh before each release as above, so
  a key read in one run opens no later run's artifact. The workflow cannot see
  when it was set, so this rests on the maintainers;
- the repository and its organisation hold no secret of these names outside
  those environments, and the repository has no other environment.

## Licence

The connector is proprietary software of Apteo AB.

Its first versions were developed in this repository under the
[AGPL-3.0](https://github.com/openbrf/mcp-connector/blob/8a7fe7c/LICENSE). The
history up to and including commit
[`8a7fe7c`](https://github.com/openbrf/mcp-connector/tree/8a7fe7c) stays public
under that licence. Later development is in the private source and is not
covered by it.

## Contributing

Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/). `pnpm test`
checks which jobs of the release workflow can read each secret.
