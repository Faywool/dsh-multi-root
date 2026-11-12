# Changelog

All notable changes to this plugin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

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
