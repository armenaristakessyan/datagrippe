# DataGrippe

Desktop database IDE (DataGrip-like) for **PostgreSQL** and **SQL Server**, focused on a polished, modern and simple UI.

## Stack

- Electron 44 + electron-vite 5 (main / preload / renderer), TypeScript strict, Node 24.
- Main process: `pg` + `pg-cursor` (PostgreSQL), `mssql`/tedious (SQL Server), `ssh2` (SSH tunnels),
  a small HashiCorp Vault HTTP client on `node:http(s)` (`src/main/vault/`).
- Renderer: React 19, Tailwind CSS v4 (tokens in `src/renderer/src/styles.css`), Zustand, Monaco editor,
  `@tanstack/react-virtual` (grid), `radix-ui` primitives, `cmdk`, `react-resizable-panels`, `lucide-react`, `sonner`.

## Layout

```
src/shared/         types.ts (domain), ipc.ts (IPC contract), sql/ (splitter, classifier, quoting, formatting)
src/main/           index.ts, ipc.ts, menu.ts, store/ (persistence), db/ (session manager, tunnel, drivers)
src/main/vault/     Vault client, login (token with OIDC fallback / OIDC / ldap / userpass), credentials, leases,
                    environment.ts (VAULT_ADDR… from the login shell), discovery.ts (secret path suggestions);
                    VaultService is injected into SessionManager (deps.vault) for connections with authMode 'vault'
src/main/import/    CSV import, DBeaver import (scans data-sources*.json only, never credentials files)
src/main/db/postgres, src/main/db/mssql   DbDriver implementations (contract: src/main/db/types.ts)
src/preload/        generic typed bridge → window.datagrippe
src/renderer/src/   lib/ (api client, commands, editor registry), stores/ (zustand), components/<feature>/
tests/integration/  driver + session-manager tests against the docker test databases (helpers/ shared setup,
                    main/ main-process flows); tests/e2e/ Playwright (Electron)
```

## Commands

- `npm run dev` — run the app with HMR. `npm run build` — production bundle in `out/`.
- `npm run typecheck` — both TS projects (node + web). Must stay clean.
- `npm run test:unit` — vitest, colocated `*.test.ts(x)` under `src/`.
- `npm run db:up` / `npm run db:down` — throwaway PostgreSQL (127.0.0.1:55432), SQL Server (127.0.0.1:51433) and
  dev-mode Vault (http://127.0.0.1:58200) from `docker-compose.test.yml`. Credentials live in `tests/test-env.ts`
  (test-only values). Inside the compose network Vault reaches the databases as postgres:5432 / mssql:1433.
- `npm run test:integration` — seeds both databases (`tests/setup/`) then runs `tests/integration/`.
  `DATAGRIPPE_TEST_DB=postgres|mssql` limits seeding to one engine. `DATAGRIPPE_TEST_DB_NAME=<name>` makes a run seed
  and use its own database (default `datagrippe_test`) so concurrent runs don't drop each other's data.
  The global setup also configures the dev Vault (`tests/setup/vault.ts`, idempotent, objects namespaced by the DB
  name: `<db>-database` / `<db>-kv` / `<db>-userpass`); it skips with a warning when the Vault container is down.
  Vault tests are `tests/integration/vault*.test.ts` (vault-renewal takes about 20 s).
- `npm run test:e2e` — builds, then Playwright drives the built Electron app (`tests/e2e/`, config in
  `playwright.config.ts`): it re-seeds both test databases, gives every test its own user data dir and HOME and fails on
  any renderer page/console error; it configures the dev Vault too (`vault.spec.ts` / `dbeaver-import.spec.ts`
  skip without it). `DATAGRIPPE_SHOTS_DIR=/some/dir` collects the step screenshots. Native menu
  accelerators can't be pressed from Playwright: specs click menu items (`dg.menu('New console')`) instead.
- `npm run dist:dir` / `npm run dist` — electron-builder: `dist/mac-arm64/DataGrippe.app` / `dist/DataGrippe-<version>-<arch>.dmg`;
  `npm run dist:release` builds both DMGs (arm64 + x64). Builds are signed ad hoc (`identity: "-"`, hardened runtime,
  electron-builder's default entitlements), not notarized. The app icon is `build/icon.png`, rendered from `build/icon.svg`.
- CI (GitHub Actions): `.github/workflows/ci.yml` (push to main, PRs: typecheck, unit, build, then integration against
  the compose containers on Ubuntu; no e2e). `release.yml` calls it, then builds and verifies both DMGs on macOS: a tag
  `v<package.json version>` publishes a GitHub release (notes: `.github/release-notes.md` + generated), a manual run
  uploads a workflow artifact. Release with `npm version patch|minor && git push --follow-tags`.
- README screenshots: `npm run build && DATAGRIPPE_DOCS_SCREENSHOTS=1 npx playwright test docs-screenshots` rewrites
  `docs/screenshots/*.png` (`tests/e2e/docs-screenshots.spec.ts`, skipped otherwise; it creates and removes its own
  dev Vault objects and uses a sanitized example.cloud DBeaver workspace in the app's own HOME).
- `node scripts/snap.mjs <outDir> <png> [userDataDir] [waitMs]` — screenshot of a build; for an outDir outside
  the repo it links `<outDir>/../node_modules` so the main bundle finds pg / mssql / ssh2.

## Contracts (change only additively, and keep every consumer compiling)

- `src/shared/ipc.ts` — every renderer ⇄ main call. Main handlers return `IpcEnvelope`; the renderer uses
  `api.*` / `call()` from `src/renderer/src/lib/api.ts`, which throws `ApiError` (with `DbErrorInfo`).
- `src/main/db/types.ts` — `DbDriver`, `DriverSession`, `MetadataProvider`.
- `src/renderer/src/stores/*` — app state; components read state through these stores.
- `src/renderer/src/components/grid/DataGrid.tsx` — `DataGridProps`, shared by results and the table editor.
- `src/renderer/src/lib/commands.ts` — command registry. Global shortcuts are native-menu accelerators
  (`src/main/menu.ts`) that emit `event:menu` with a command id; never bind the same keys again in the renderer.
- Vault connections: `ConnectionConfig.authMode: 'vault'` + `vault` (VaultConfig); `user` is issued by Vault and
  `savePassword` applies to the Vault token / password. A `needs-password` error's `secretField` says which secret to
  prompt for (`password`, `vaultToken`, `vaultPassword`); renderer UI shared by the connection and import dialogs
  lives in `components/vault/` (`config.ts` mirrors `normalizeVaultAddress` / `normalizeSecretPath` from `src/main/vault/`).

## Engineering rules

- Security: `contextIsolation: true`, `sandbox: true`, no `nodeIntegration`. Passwords are encrypted with
  Electron `safeStorage` in main and never sent to the renderer. Data edits use parameterized queries.
- Vault tokens, database passwords and lease secrets never reach the renderer, logs, error messages, history or
  disk in clear (only the safeStorage SecretStore, and `store/vault-tokens.ts` for OIDC sign-ins). Never read
  DBeaver's `credentials-config*.json`, never write `~/.vault-token`, never read VAULT_TOKEN from the login shell.
  Real hostnames, Vault addresses and mount paths never go in fixtures, tests or docs (use example.cloud /
  example.internal / example.shared and the sanitized layouts of `discovery.test.ts`).
- Automation guard (`src/main/automation-guard.ts`): when the app is driven by automation (`DATAGRIPPE_AUTOMATION=1`
  or Playwright) every database / SSH / Vault target must be loopback (checked in `db/drivers.ts`, `db/tunnel.ts`,
  `VaultClient.request`), the login shell is never read for VAULT_ADDR (`vault/environment.ts`), and the default
  DBeaver scan is refused unless HOME was substituted (the IPC handler returns a warning instead). Screenshot scripts and agents driving the app set `DATAGRIPPE_AUTOMATION=1` and a
  throwaway HOME / user data dir; never point them at the real DBeaver workspace (it holds production connections).
  Smoke tests of the packaged `.app` also set `DATAGRIPPE_NO_KEYCHAIN=1` (secrets in memory only): an unsigned
  rebuild would make macOS ask the user for keychain access and block startup.
- Values crossing IPC are structured-clone friendly; DB values are normalized to `CellValue` in main
  (no JS `Date`, no precision loss for bigint/numeric).
- No `any` unless unavoidable at a library boundary (then narrow immediately). No new npm dependencies
  without a strong reason.
- Main-process code is bundled as CommonJS: don't import ESM-only packages there (use `node:crypto` `randomUUID`).

## UI guidelines

- Use only the semantic tokens (`bg-panel`, `bg-surface`, `bg-elevated`, `text-fg`, `text-muted`, `text-subtle`,
  `border-line`, `bg-accent`, `text-danger`, …) — never raw palette colors like `bg-zinc-800` — so dark and
  light themes both work. Merge classes with `cn()` from `@/lib/cn`.
- Dense IDE scale: base text `text-sm` (13px), secondary `text-xs` (12px), meta `text-2xs` (11px);
  controls 26–28px tall, toolbar icons 14–16px (`lucide-react`, `strokeWidth` 1.75–2).
- Radii `rounded-md` (controls), `rounded-lg` (popovers), `rounded-xl` (dialogs). Popovers use `shadow-popover`,
  dialogs `shadow-dialog`. Borders are 1px `border-line`; avoid heavy boxes, prefer spacing and subtle dividers.
- Layout and palettes follow JetBrains' Islands themes (DataGrip): the window frame (`bg-app`: title bar, tool
  stripes, status bar) shows around and between rounded panels (`rounded-lg`, `bg-panel` / `bg-surface`), which
  `SplitHandle variant="gap"` separates; a console is two panels (tabs, toolbar and editor, then results). `Sheet`
  tool windows open between the title bar and the status bar, next to a tool stripe.
- The title bar drags the window: descendants inherit its app-region and Chromium hands the boxes to the OS in tree
  order, so keep each child to its own box (no full-width overlay after a `no-drag` control) and keep overlays out of
  it. `shell.spec.ts` replays that computation for the title bar and the query history buttons.
- Code, identifiers and grid cells use `font-mono` (code text in `text-code`); numbers in tables use `tabular`.
- Every view handles loading, empty and error states. Keyboard-first: every action reachable from the
  command palette, focus rings visible (`focus-visible`).
- Motion is subtle (≤150ms opacity/transform). Respect `prefers-reduced-motion`.
- UI copy is English, sentence case, concise.
