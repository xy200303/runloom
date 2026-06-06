# Runloom Changesets

Use Changesets to track version and changelog entries for published packages.

Add a changeset when a change affects a published package:

```bash
pnpm changeset
```

Runloom currently publishes `runloom-agent` and `runloom-tui`. `runloom-web` is deferred and must not be added to release workflows until the Vue implementation exists.

Do not add a changeset for documentation-only changes, tests-only changes, or root tooling that does not affect package consumers.
