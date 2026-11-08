<p align="center">
  <a href="https://docleus.io"><img src="./.github/assets/docleus.svg" width="88" alt="Docleus logo" /></a>
</p>

<h1 align="center">Collaboration</h1>

<p align="center">
  <strong>Write on the same page. Together.</strong><br />
  Yjs and Hocuspocus collaboration backed by durable Docleus revisions.
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" /></a>
  <img alt="Public preview in preparation" src="https://img.shields.io/badge/preview-0.0.7-cfcfcf?style=flat-square" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square" />
  <a href="https://docleus.io"><img alt="Online documentation" src="https://img.shields.io/badge/docs-docleus.io-111111?style=flat-square" /></a>
</p>

<p align="center">
  <a href="https://docleus.io">Documentation</a> &middot;
  <a href="#install">Install</a> &middot;
  <a href="https://github.com/Docleus/docleus">Run Docleus</a> &middot;
  <a href="https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md">Contribute</a>
</p>

---

Real-time collaborative editing for Docleus pages with Yjs and Hocuspocus. Everyone editing the same page on the same branch shares one Yjs document and sees the others' carets. Revisions stay the source of truth: the plugin commits the shared document to the branch as a normal revision on idle, on an explicit save, on `content/flush`, and when the last editor leaves.

## Install

Add this row to the deployment config's `plugins` list. Paths resolve relative
to that file. The default distribution already includes this plugin.

```yaml
plugins:
  - id: collab
    plugin: ../docleus-plugin-collab
    config:
      idleDelay: 3000
```

Run `pnpm build` first: the instance loads `dist/server/index.js` and `dist/editor/index.js` from `docleus.plugin.json`. Organizations created in the browser enable installed plugins automatically; existing organizations or spaces with explicit overrides can enable it in Settings, Plugins. It needs `docleus-plugin-editor`, which provides `ctx.editor` and the `yjs` module of the import map.

| Config      | Values                | Default | Does                                                      |
| ----------- | --------------------- | ------- | --------------------------------------------------------- |
| `idleDelay` | a positive number, ms | `3000`  | How long after the last edit the shared document commits. |

The server entry needs the `storage`, `content`, `http`, `authz`, `installations` and `identity` services.

## How it works

- **Documents.** One shared document per page and branch, named `<spaceId>/<branch>/<entryId>`, with the body in the `default` XML fragment, encoded as `y-prosemirror` (`@tiptap/y-tiptap`) encodes it. The server reads and writes it without ProseMirror, from a plain-data schema description the editor sends as the connection token.
- **Storage.** The plugin's table `collab_documents` keeps each document's Yjs state, the revision it last synced with and the schema description. A document loads from that state; without one, or when the branch moved on since, it is seeded from the page body at the branch head.
- **Snapshots.** A snapshot turns the fragment back into a block tree (untouched blocks keep their ids and attrs), and commits it when it differs from the head, with the last user who edited as author. A save that loses a race to another commit reloads the document from the new head. `content/flush` (sent by `docleus-plugin-change-requests` before merge, rebase and conflict listing) snapshots the documents of the branch first.
- **Foreign commits.** A commit to the page's branch that did not come from this plugin resets the shared document to the new body; connected editors follow.
- **Presence.** Carets and names go through Yjs awareness. Each user gets a stable color.

## Access

Connections go to the WebSocket at `/api/collab` (through `ctx.http.upgrade`) with the session cookie. A connection to a page is allowed when the user has `write` on the space, the plugin is enabled for it, the page exists at the branch, and `ctx.content.checkCommit` accepts a commit by the user to that branch (so `docleus-plugin-change-requests` keeps `main` read-only where its workflow says so). Refusals carry one of `collab/forbidden`, `collab/not-enabled`, `collab/space-not-found`, `collab/branch-not-found`, `collab/page-not-found`, `collab/invalid-document`, `collab/no-schema`, or the code of the rejected commit check.

The server repeats these checks before processing each message, including updates, presence and saves, and closes a refused document connection before applying its message. It also checks the snapshot's author before committing a revision. Already accepted edits remain in Yjs storage when a snapshot is refused.

`GET /api/orgs/:orgId/spaces/:spaceId/pages/:pageId/collab?branch=<name>` answers `{ canShare: true, user: { name, color } }` or `{ canShare: false, reason }` with the same checks; the editor asks it before connecting.

## Editor

The editor entry registers a collaboration provider with `ctx.editor.registerCollaboration`. For a page the user can share, it connects `@hocuspocus/provider` (bundled; `yjs` comes from the host's import map) to `ws(s)://<host>/api/collab`. Save sends a stateless `save` message and waits for the server's reply. Pages the user cannot share open in single-user mode.

## Tests

- `pnpm test`: unit tests next to the code (encoding against `@tiptap/y-tiptap`, snapshot bodies, access, config, the editor provider), and integration tests (`tests/collab.test.ts`) against a real listening instance: convergence, presence, explicit, idle, leave and flush snapshots, foreign commits, a server restart mid-edit, and access.
- `pnpm e2e`: Playwright tests in `tests/e2e/`. They build core, `docleus-plugin-editor`, `docleus-plugin-blocks-commonmark`, `docleus-plugin-change-requests` and this plugin, then start and restart `docleus serve --dev` on port 4341 themselves.

## Development

Use Node.js 24 and pnpm 11.21.0. Keep this repository next to `docleus-core`
with its original directory name; the `link:` development dependencies need
that layout. Install core before this repository:

```sh
pnpm --dir ../docleus-core install --frozen-lockfile
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

`pnpm check` runs typecheck, lint, formatting, dependency boundaries, licenses,
and unit/in-process integration tests. Browser and external-service tests,
where provided, are separate and need the sibling repositories listed in
their setup files. The SDK is a host-provided peer dependency; packages remain
private and are not installed from npm. All extension points are experimental
before 1.0.

## Community

[Contributing](https://github.com/Docleus/.github/blob/main/CONTRIBUTING.md) &middot;
[Code of conduct](https://github.com/Docleus/.github/blob/main/CODE_OF_CONDUCT.md) &middot;
[Security](https://github.com/Docleus/.github/blob/main/SECURITY.md) &middot;
[Support](https://github.com/Docleus/.github/blob/main/SUPPORT.md)

## License

[MIT](LICENSE)

## Compatibility

Version `0.0.7` supports Docleus core and SDK `0.0.1`, `0.0.2`, `0.0.3`, `0.0.4`, `0.0.5`, `0.0.6` and `0.0.7` through
the matching `>=0.0.1 <0.0.8` manifest and SDK peer ranges.
