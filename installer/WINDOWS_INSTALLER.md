# Windows installer architecture

The canonical installer is a per-user custom NSIS package for the Electron
desktop application. Its default location is:

```text
%LOCALAPPDATA%\Programs\Foundry VTT MCP Bridge
```

The directory page remains enabled, so the user can choose a different
location. The installed executable is `FoundryVTT MCP Bridge.exe`. A standalone
Node runtime is retained at `runtime\node.exe` for backend supervision and
installer helpers. Installer-managed MCP clients use the GUI-subsystem desktop
executable with `ELECTRON_RUN_AS_NODE=1`, so stdio startup does not flash a
console window. The wrapper/backend bundles live under `resources\server`.

## Build

From the repository root on Windows:

```powershell
node installer/build-nsis.js --version 0.13.0
```

`build-nsis.js` first verifies that the selected version matches all six release
manifests, then rebuilds the MCP server bundles, default Electron Windows
directory, and bundled Foundry module. Pass `--skip-desktop-build` only for an
intentional reuse of an already verified Electron directory. The
`--skip-server-build` option is restricted to `--skip-nsis` fixture/static
staging and cannot compile a release installer. A release build downloads
pinned Node.js v22.12.0 from nodejs.org and verifies the ZIP
against the corresponding official `SHASUMS256.txt` entry before extracting
`node.exe` and its license.

The script expects `makensis` on `PATH`, at a standard NSIS installation path,
or at the absolute path in `MAKENSIS`. The output uses the desktop product name:

```text
installer\build\FoundryVTT-MCP-Bridge-Setup-<version>.exe
```

The custom build does not currently sign the setup executable. Release
automation needs a Windows code-signing certificate and a post-build signing
step before public distribution if SmartScreen publisher identity is required.

Static staging uses:

```powershell
node installer/build-nsis.js --skip-download --skip-nsis
```

That mode is deliberately non-release. On Windows it copies the developer's
current Node executable and adds `runtime\STAGING_ONLY.txt`; on other hosts it
uses an inert `node.exe` placeholder. The build script refuses to compile NSIS
when `--skip-download` is present.

## Upgrade identity and migration

Programs & Features continues to use the legacy HKCU key
`...\Uninstall\FoundryMCPServer`, so an old release upgrades in place from
Windows' perspective. The new registration includes quoted uninstall commands,
install/icon locations, version, publisher, project URL, and estimated size.

Before copying files, setup:

1. Detects only a recognized current or legacy registration/root.
2. Requests the exact desktop executable to exit via `--shutdown-for-update`.
3. Stops stdio wrappers only when both their executable path and wrapper-script
   argument exactly match the selected current or fully fingerprinted legacy
   installation. A bounded quiet period catches immediate client restarts;
   unrelated Node processes are never terminated.
4. Pings the control listener and shuts it down only when `entryPath` belongs
   to that installation. The no-identity legacy fallback requires the complete
   legacy file fingerprint.
5. Copies a valid existing server profile JSON to the canonical path when it
   is not already present.
6. Migrates bridge-owned MCP client registrations. If any owned registration
   cannot be migrated safely, setup preserves the previous payload rather than
   leaving a client pointed at a deleted executable.
7. Cleans only a validated manifest-owned current payload or the fixed legacy
   allowlist. It never launches the prior interactive uninstaller.

The canonical settings file is:

```text
%APPDATA%\FoundryVTT MCP Bridge\foundry-servers.json
```

An existing valid canonical file wins and is left byte-for-byte unchanged. An
invalid canonical file stops installation and is not replaced. When it is
absent, migration first checks the exact `FOUNDRY_SERVERS_CONFIG` referenced by
known Foundry MCP entries in Claude Desktop and Codex, then recognized legacy
install locations. A valid source is copied before any legacy payload cleanup.
The whole Electron user-data directory is preserved by default during
uninstall.

## Deletion boundaries

`installer-owned-files.json` identifies every staged application payload file.
The NSIS-created `Uninstall.exe` is removed separately by the guarded installer
or uninstaller flow. Cleanup preflights the entire manifest before the
first deletion, rejects absolute/escaping paths, rejects reparse-point roots or
ancestors, deletes only listed files, and removes only directories that become
empty. Unknown files keep their containing directory in place.

The optional Foundry module keeps the earlier root validation and adds a
dedicated no-follow cleanup helper. It preflights every item below all five
allowlisted code trees for reparse points before the first mutation; a nested
link or junction aborts the whole cleanup plan. Replacement and removal target
only `dist`, `lang`, `scripts`, `styles`, `templates`, and `module.json`.
Generated maps and unknown/user files remain. World cleanup is restricted to
the retired exact filename `enhanced-creature-index.json` and skips linked world
directories.

Client registration covers these user-scoped formats only:

- Claude Desktop JSON at its standalone and detected MSIX roaming locations;
- Claude Code JSON at `%USERPROFILE%\.claude.json`, when that file exists;
- Codex TOML at `%USERPROFILE%\.codex\config.toml`, when that file exists.

The known entry names are `foundry-mcp`, `foundry-vtt-mcp`, and
`foundry-vtt-mcp-bridge`. An entry is owned only when it carries the exact
`FOUNDRY_MCP_MANAGED_BY=io.github.webmaster94.foundry-vtt-mcp` marker or has
exactly one script argument and its command/script pair matches one installation
root in either layout:

```text
<root>\FoundryVTT MCP Bridge.exe
<root>\resources\server\index.bundle.cjs

# Previous desktop release (recognized for migration/removal)
<root>\runtime\node.exe
<root>\resources\server\index.bundle.cjs

# Legacy server-only release
<root>\node.exe
<root>\foundry-mcp-server\packages\mcp-server\dist\index.cjs
```

Foreign same-name entries, relative commands, extra arguments, mixed roots, and
unverifiable source/development registrations are not claimed. During install
only, `command = "node"` or `node.exe` with one absolute
`packages\mcp-server\dist\index.js`/`index.cjs` argument is migratable when the
root package, server package, and Foundry module manifests exactly identify this
project. The source checkout is never modified or removed. A refused install mutation writes no backup and
leaves the file byte-for-byte unchanged. JSON and TOML inputs must be regular,
non-reparse files. Successful mutations recheck the originally parsed byte hash
immediately before an atomic same-directory replacement and preserve a
timestamped, byte-exact backup. A concurrent client write wins and causes the
installer mutation to stop; Codex also preserves UTF-8 BOM and newline style.
Project-local Claude/Codex files are never scanned. Required owned-only
uninstall cleanup applies the same ownership rules. Uninstall will not remove shortcuts,
registration, module code, or application payload until owned-client cleanup has
completed successfully. Interactive failures offer retry or cancel; silent
uninstall cancels with a non-zero exit and leaves the runtime installed rather
than orphaning an owned registration.

## Safety tests

Run the isolated fixture/static suite on Windows:

```powershell
npm run test:windows-installer-safety
```

It does not install the application or modify the registry. All writable paths
are under a test-owned temporary directory, and all client tests use explicit
fixture paths. Coverage includes clean install metadata, valid configuration
preservation and Claude/Codex discovery, custom legacy migration to the proper
Programs location, allowlist cleanup, malicious manifest escapes, junction
roots, user-data survival, exact Claude Desktop/Claude Code/Codex migration,
foreign and ambiguous entry refusal, byte-exact TOML backup/removal, owned-only
cleanup, exact current/legacy wrapper shutdown, and unrelated Node/control
processes that must remain running.

Also run the repository's cross-platform module-link guard:

```powershell
npm run test:installer-safety
```

For a release candidate, test interactively in a disposable Windows user or VM:

- clean install to the default and a custom directory;
- upgrade from the last legacy installer and the immediately previous desktop
  installer;
- silent uninstall (`Uninstall.exe /S`) and interactive uninstall;
- tray/app shutdown during upgrade;
- Start Menu and Programs & Features fields;
- optional Foundry module install/remove against stable, preview, and custom
  data paths;
- preservation of `%APPDATA%\FoundryVTT MCP Bridge` and unrelated MCP entries.

The release workflow also exercises the compiled installer on an isolated
Windows runner. It verifies that a foreign same-name Codex entry cannot hang or
be changed by silent install/upgrade, and that a forced client-cleanup failure
causes silent uninstall to retain the entire registered payload before a clean
retry succeeds.
