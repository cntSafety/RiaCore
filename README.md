# RiaCore

A desktop application for working with RIA graph data, built as a pnpm monorepo with TypeScript.

Main repository: [github.com/cntSafety/RiaCore](https://github.com/cntSafety/RiaCore)

## Download

You do not need to build anything to try RiaCore. Prebuilt applications are published in the
[Releases section](https://github.com/cntSafety/RiaCore/releases) of the main repository:

- **Windows** — installer, plus a portable version that runs without installing
- **macOS** — `.dmg`
- **Linux** — `.AppImage`

Grab the package for your platform, start the app, and continue with
[Getting Started with Sample Data](#getting-started-with-sample-data).

## Screenshots

![RiaCore desktop app — namespace tree and analysis view](readme_img.png)

![RiaCore desktop app — safety analysis working area](readme_img2.png)

## ⚠️ Qualification notice

**No tool qualification is provided with RiaCore.** Before using it in any project, the qualification
has to be performed according to that project's specific requirements and the applicable safety
standards — for example ISO 26262, IEC 61508, or others relevant to your domain. Deciding on the
required qualification measures, performing them, and documenting the evidence remains the
responsibility of the using project.

## Getting Started with Sample Data

The fastest way to get something on screen is the reference project:
[github.com/cntSafety/ref-project](https://github.com/cntSafety/ref-project).

It ships a ready-to-use workspace — importer configs, sample source data (ARXML, SysML, and more), and
persisted `ria-data` — so you can open it directly in RiaCore instead of assembling a workspace and
import configuration by hand.

```bash
git clone https://github.com/cntSafety/ref-project.git
```

Then point RiaCore at the cloned directory as its working directory and load the data from there.

## Where data lives

For a given working directory:

- `db/` — the embedded KuzuDB graph database, created automatically on first use
- `ria-config/` — importer configuration
- `ria-data/` — git-friendly JSON export of the graph, written when you store the database
- `logs/` — log output

> **⚠️ Keep the database and logs out of git.** `ria-data/` is the versioned artifact — the full graph
> state lives in those JSON files and can be restored into a fresh database at any time. The `db/`
> directory is a regenerable binary cache, and logs are runtime noise; committing either bloats the
> repository and produces meaningless diffs. Add this to the `.gitignore` of your workspace repository:
>
> ```gitignore
> # Logs
> *.log
> logs/
>
> # Database files
> db
> db.wal
> *.db
> *.db.wal
> ```

---

## Building from source (optional)

Only needed if you want to develop RiaCore or build your own packages. For normal use, take a
prebuilt application from the [Releases section](https://github.com/cntSafety/RiaCore/releases) instead.

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 9

### Setup

```bash
cd RiaCoreDev
pnpm install
pnpm build
```

> **⚠️ Git binary for packaging:** The `pnpm install` step downloads a bundled git binary via the `dugite` package (used by `@riacore/git-service`). If the download fails (e.g. due to a corporate proxy or TLS certificate issue with error `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`), the app will not work — both in packaged builds and during local development. To fix this, either set `NODE_EXTRA_CA_CERTS` to your corporate CA certificate before running `pnpm install`, or manually download the dugite-native release from [GitHub](https://github.com/desktop/dugite-native/releases) and extract it into `node_modules/.pnpm/dugite@2.7.1/node_modules/dugite/git/`.

### Run in development (Electron)

From the repo root, a single command starts both the Vite dev server and Electron:

```bash
cd RiaCoreDev
pnpm dev
```

This works on Windows, macOS, and Linux. It starts the renderer dev server, waits until it's ready on `http://localhost:5173`, then launches Electron automatically. Closing either process shuts both down.

If you see `ERR_CONNECTION_REFUSED`, the dev server hasn't finished starting yet — it will retry automatically.

### Desktop Packaging

Native desktop packages are built on each target OS separately. Do not try to package macOS or Linux artifacts on Windows.

Current release target matrix:
- Windows x64
- macOS arm64
- Linux x64

The packaged desktop app bundles a platform-specific Node sidecar because the Kuzu-backed worker must run under standard Node.js rather than Electron's ABI-modified runtime.

Build from the repo root:

```bash
pnpm package:desktop:win
pnpm package:desktop:mac
pnpm package:desktop:linux
```

Generated paths:
- Staging directory used during packaging: `apps/desktop-host/.release/`
- Final packaging output: `apps/desktop-host/dist-electron/`
- Windows unpacked app for smoke testing: `apps/desktop-host/dist-electron/win-unpacked/`

Distribution artifacts are written to `apps/desktop-host/dist-electron/` by `electron-builder`, for example:
- Windows: installer, portable zip, and unpacked app directory
- macOS: `.dmg`
- Linux: `.AppImage`

`asar` is currently disabled for packaged builds because the external Node worker cannot reliably load its runtime modules from `app.asar`.
