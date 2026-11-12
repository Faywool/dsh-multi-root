# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `workspace_grep` tool: search file *contents* across every attached root in one
  call, with `glob`, `regex`, `ignoreCase`, `context`, `alias` and `maxResults`.
  Output groups matches by root and always ends with a trailer (files visited,
  files scanned, binary/oversize skips, elapsed) plus the reason a search was
  truncated, so "no match" cannot be confused with "gave up early".
- Per-workspace `searchEnabled` switch (panel checkbox next to the workspace
  picker, `/multi-root search [on|off]`, `POST /dsh-multi-root/state` with
  `action: "search"`). Off means the tool answers one sentence and reads nothing.
- A glob without a path separator (`*.cs`) matches the file name at any depth;
  a glob with one (`src/**`) matches the relative path.
- Build and test commands per root: `src/build.js` scans two levels down for the
  shallowest `.sln`, a `package.json` with a `build` script (package manager from
  the lockfile), or a single `.csproj`, and publishes the result in the prompt
  section and the panel. `/multi-root build|test <ref> "<command>"` and
  `workspace_roots action: "build"` override it; an empty value goes back to
  detection.
- `workspace_git` tool: `status`, `diff` and `log` across every attached root in
  one call, including ahead/behind and the last commit. Read only.
- The root table's git column now shows `↑ahead` / `↓behind` next to the branch.
- `mode: "readonly"` is enforced at execution time through `ctx.tools.guard` for
  write-like tools. Paths that cannot be resolved to an absolute path are let
  through on purpose (fail open).

### Fixed

- The store now keys workspaces through `canonicalKey`, the same spelling the
  routes and tools use. Documents written with the older backslash keys are
  re-keyed on first read and written back, so an existing root list cannot look
  empty after the upgrade.

## [0.1.0] - 2026-11-12

First release. The plugin re-implements the multi-root workspace feature without
touching `ctx.fs` or `ctx.sandbox`, so a broken install cannot take DSH down.

### Added

- Attach up to 64 extra repositories to one workspace (default 16), stored per
  workspace path in `$DSH_HOME/storages/dsh_multi_root.json` with a stable
  record id, alias, aliasId, access mode, per-root skills switch and `addedAt`.
- A per-session prompt section listing every attached root with its absolute
  path, access mode, git branch and dirty marker, plus each root's own
  `AGENTS.md` notes within the same byte budget.
- `workspace_roots` tool: `list`, `attach`, `detach`, `import`, `rename`,
  `mode`, `skills`, `move`, `reveal`, `namespace`, addressed by id → alias →
  absolute path.
- `workspace_find` tool: cross-root file search, since the host file-reference
  index only covers the session working directory.
- `/multi-root` command with `list`, `attach`, `detach`, `find`, `dirs`,
  `alias`, `mode`, `skills`, `move`, `open`.
- Skills provider that exposes `<aliasId>-<skill>` from each attached root's
  `.claude/skills`, `.agents/skills` and `.dsh/skills` directories.
- HTTP routes `GET/POST /dsh-multi-root/state`, `GET /dsh-multi-root/browse`
  and `GET /dsh-multi-root/file` with same-origin checks and read-only path
  confinement.
- Client half: a sidebar footer entry that opens a modal, and a settings
  section, both rendering the same root table with inline rename and skill
  namespace editing.
- Fail-soft contract: an empty `inject`, no `disabled` upstream rows, every
  contribution registered through scoped `ctx.inject` or a guarded optional
  lookup, and no writes to host-owned storage.
