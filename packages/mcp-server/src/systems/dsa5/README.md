# DSA5 support

The DSA5 adapter translates Foundry's `dsa5` actor data into the common character response used by MCP tools. Compendium queries use the generic live-data search path instead of a duplicate persistent database.

## Extracted character data

`DSA5Adapter` currently reports:

- AP totals, spent/available AP, and experience tier
- LeP, AsP, and KaP resources
- Eigenschaften (MU, KL, IN, CH, FF, GE, KO, KK)
- initiative, speed, dodge, and armor
- species, culture, profession, and size
- magical/clerical tradition and spellcasting availability

The adapter is registered for the exact Foundry system id `dsa5`. Keep extraction tolerant of missing fields because DSA5 data shapes can differ between actor types and system releases.

## DSA5-specific tools

The backend also exposes focused archetype workflows implemented by `character-creator.ts`, including listing available archetypes and creating a DSA5 character from an archetype. These writes must continue to use the normal permission, validation, and audit paths.

## Development

When DSA5 changes its schema:

1. Inspect actor data from a live supported world.
2. Update field paths in `adapter.ts` and the archetype creator as needed.
3. Add fixtures for missing fields and changed resource shapes.
4. Run `npm run build`, `npm test`, and the live smoke suite before release.

Do not add persistent world indexes for adapter data. Use bounded generic compendium queries for search and add a focused adapter field only when it improves character-oriented output.
