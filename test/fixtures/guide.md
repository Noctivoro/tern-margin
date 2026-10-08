# Release guide

This guide covers how a release moves from a tagged commit to a published
package. Read it once before your first release.

## Before you start

You need:

- write access to the repository;
- a clean working tree on `main`;
- the release token in your keychain.

| Step | Owner | Command |
| --- | --- | --- |
| Tag | Maintainer | `git tag -a v1.2.0` |
| Build | CI | `npm run build` |
| Publish | CI | `npm publish` |

## Steps

1. Update the changelog.
2. Tag the release:
   ```sh
   git tag -a v1.2.0 -m "v1.2.0"
   git push origin v1.2.0
   ```
3. Watch the release workflow until it finishes.
   ```sh
   gh run watch --exit-status
   ```
4. Check the package page.

### Markup examples

Reviewers leave comments as CriticMarkup. These examples are literal text:

```text
Comment:      {>>comment<<}
Insertion:    {++new text++}
Deletion:     {--old text--}
```

Inline, `{>>this is also literal<<}` because it sits in a code span.

> **Note:** a failed publish leaves the tag in place. Delete it before you
> try again.

Rollback
--------

Run `npm deprecate` for the bad version, then publish a patch release.
See [the npm docs](https://docs.npmjs.com/cli/commands/npm-deprecate) for
the exact flags.

- [ ] Changelog updated
- [ ] Tag pushed
- [x] Workflow green

<details>
<summary>Old process</summary>
Releases used to be manual.
</details>

---

Questions go to the release channel.
