# Desktop Brand Assets

The desktop icon is assembled from separately owned layers:

- `vendor/foundry/fvtt-d20.png` is an unchanged official Community Content Kit
  asset. Its provenance and usage notice are in `../THIRD_PARTY_NOTICES.md`.
- `brand/app-icon-background.svg` and `brand/mcp-bridge-glyph.svg` are
  project-owned, code-native vector assets. The bridge glyph is a text-free
  three-node network topology; it does not modify the Foundry source layer.
- `generated/` contains deterministic PNG and Windows ICO outputs produced by
  `scripts/build-desktop-icons.mjs`.

Run the generator from the repository root after installing the pinned workspace
dependencies:

```sh
npm ci
npm run build:desktop-icons
```

Do not edit generated files by hand. The generator verifies the official source
asset's SHA-256 before composing anything, emits an output manifest and a
physical-pixel preview, and fails if required sizes, transparent edges, topology
parts, or distinguishable tray-state marks are missing.

The 16, 20, 24, and 32 px shell frames intentionally show the official d20
alone; tray variants add only the state mark. At those sizes, preserving the
d20's silhouette is clearer than forcing in a second glyph. The text-free
topology is direct-rendered at 40 and 48 px and included in the larger master
artwork.

The Electron tray loader combines the 16, 20, 24, 32, 40, and 48 px files into
one multi-representation `NativeImage` per connection state. This lets Windows
choose a native physical size instead of enlarging the 16 px representation.

Run `npm run test:desktop-icons` to verify source and output hashes, the PNG/ICO
inventory, runtime aliases, full-edge transparency, and Electron/electron-builder/
NSIS resource wiring. `generated/icon-preview.png` shows app, connected, waiting,
and error rows at 16, 20, 24, 32, 40, and 48 px (plus the 256 px app master),
enlarged with nearest-neighbor sampling.
