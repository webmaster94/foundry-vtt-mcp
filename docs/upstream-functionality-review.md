# Upstream functionality review

Reviewed 2026-09-23. Local baseline `799a4a8`, upstream `cbca58ce369cd5e6f1a90edb3aacc40f4cdf6d7c`, common baseline `259d402b30d8eee16453dbb444c97d1b8bf76398`. This is a source review, not live Foundry validation. No upstream runtime code was imported.

## Recommendation

Keep the fork's generic Game API. Upstream contains several useful defect reports and regression cases for retained compatibility tools. Importing whole feature commits would also restore system-specific wrappers, large creature indexes, and write paths that bypass the fork's generic document workflow.

## Ranked candidates

### 1. Preserve Activity save and serialized Advancement data

Confirmed local data-loss paths. `packages/foundry-module/src/data-access.ts`, `isSensitiveOrProblematicField`, excludes every `save` and `advancement` key. `safeJSONStringify` independently excludes object-valued `save`. Thus valid D&D5e Activity save configuration disappears. `getCompendiumDocumentFull` sanitizes `document.toObject()` and also loses safe serialized Advancement data.

Upstream `ffffbfc` restricts the save exclusion to the deprecated D&D5e ability accessor. `6340c37` restores Advancement from serialized source, while retaining protection against traversing live cyclic Advancement objects. [PR 110](https://github.com/adambdooley/foundry-vtt-mcp/pull/110) explains both failures and supplies regression tests.

Adapt the fixes to retained legacy readers, or route those readers through a shared bounded serializer after proving equivalent prepared-state behavior. The local `packages/foundry-module/src/document-serializer.ts` does not have these global exclusions, so this is not a demonstrated defect in every generic read. Test source versus prepared data explicitly. Preserve byte limits and secret filtering.

### 2. Read the exact synthetic actor being addressed

Confirmed lookup gap in local `packages/foundry-module/src/data-access.ts:getCharacterInfo`. It searches only world actor ID/name. Meanwhile `findActorByIdentifier` supports bare scene token IDs for some writes. A token-local edit can therefore lack an equivalent `get-character` read.

Upstream `5c6c30f`, [PR 111](https://github.com/adambdooley/foundry-vtt-mcp/pull/111), adds exact Token UUID and unique bare Token ID resolution, ambiguity errors, and representation metadata. Keep actor-ID lookup returning the world actor. Resolve explicit tokens through `TokenDocument.actor` so prepared ActorDelta state is read. Adapt tests before sharing a resolver across read/write paths. Existing fuzzy write lookup is not equivalent to upstream's exact read resolution.

### 3. Correct journal rename identity handling

Confirmed local defect in both `packages/mcp-server/src/tools/quest-creation.ts:handleUpdateQuestJournal` and `packages/foundry-module/src/data-access.ts:updateJournalContent`. When `pageId` and `newPageName` coexist, the server's new-page branch drops `pageId`, and the module also prioritizes creating a page over updating the named page.

Upstream `6f86d8c` and `70c19eb` address issue 95. Fix the two layers together, preserving existing content-update semantics and recording an inverse through the fork's document service where possible. Do not import `df8b4d6` wholesale: its extra `replace-journal-page` wrapper duplicates generic `JournalEntryPage` updates. Its verification only checks that content is nonempty, which does not prove the requested replacement succeeded.

### 4. Report item-targeting failures accurately

Local `packages/foundry-module/src/data-access.ts:useItem` calls `game.user.updateTokenTargets` without checking availability, uses the active scene rather than the displayed canvas scene, and only logs unresolved target names. Upstream `bd13fd1`, [PR 105](https://github.com/adambdooley/foundry-vtt-mcp/pull/105), contains compatibility logic and structured targeting results in the same file plus `data-access.use-item.test.ts`.

This is a credible V13/V14 compatibility candidate, not a locally reproduced version failure. Do not adopt the upstream policy of proceeding with item use after targeting fails automatically. A resource-consuming action on stale targets needs an explicit contract and live validation. Transfer detection and reporting ideas first.

### 5. Expose nested item effects through compatibility readers

Upstream `708c0b2`, `91125e6`, `447c915`, `e55846b`, and `59ea4d6` improve serialized item systems, item-owned effects, nested lookup, and rejection of effects through item-only updates. Local `data-access.ts:getCharacterInfo` omits item effects; its character entity lookup searches actor effects directly. These are real omissions in legacy convenience responses.

The fork already supports `ActiveEffect` under Actor and Item through `packages/foundry-module/src/document-registry.ts`, `document-service.ts`, and `packages/mcp-server/src/tools/document-management.ts`. Prefer consistent UUID-based nested reads over a second effect API. Evaluate bounded output before adding every item effect to character summaries. Do not import `295e46f`'s `manage-effects` wrapper.

### 6. Small PF2e summary improvement

Upstream `3f5b708` and `6ba56df`, [PR 112](https://github.com/adambdooley/foundry-vtt-mcp/pull/112), add `system.details.languages.value/details` to `packages/mcp-server/src/systems/pf2e/adapter.ts:extractCharacterStats`. The local summary lacks this field. This is a small useful addition if character summaries remain supported; raw document reads already provide the underlying data. Preserve real language slugs and optional free text.

## Features already covered or unsuitable as imports

| Upstream work                                                   | Local assessment                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `08c975d`, `87d4651`, `2f96453`, scene music and playlist tools | Local generic Playlist/PlaylistSound CRUD, Scene source reads/updates, and `document-service.ts:playlistSoundAction` already cover the core operations. Upstream resolved-document-to-ID normalization is a useful regression case if adding music to scene summaries. Whole-playlist play/stop is a possible convenience gap, not grounds for a new tool family.                                                             |
| `ea8c3b4`, `2e48b7f`, `manage-actors` and placement             | Actor CRUD and Scene Token embedded creation already fit the local generic API. Do not restore the upstream wrapper.                                                                                                                                                                                                                                                                                                          |
| `cf64001` and MGT2e normalization series                        | Local `systems/mgt2e/adapter.ts` and `normalize.ts` already retain character extraction and normalization while deliberately excluding creature indexing. No reason to restore upstream index/filter machinery.                                                                                                                                                                                                               |
| `fe122af`, DSA5/WFRP detection                                  | Local `CharacterTools.getAdapter` and `DocumentManagementTools.getAdapter` consult `detectGameSystemInfo().systemId` before the reduced enum. DSA5/WFRP adapters therefore remain reachable despite not appearing in that enum. Upstream enum expansion does not by itself fix a demonstrated local routing failure.                                                                                                          |
| `80ee61a`, `1a10359`, DSA5 normalize/describe                   | Potential convenience additions, not proven generic API defects. Inspect actual DSA5 workflows before adopting coercion/defaults. Use local schema discovery and preserve arbitrary system data.                                                                                                                                                                                                                              |
| `aa79bb6`, D&D5e feature construction                           | Local builders lack the new uses tracker and flat damage bonus input. The commit also introduces template cloning from specific Monster Manual actors and broad payload changes. Separate narrow schema/default fixes from optional convenience features; do not import the commit wholesale. Generic embedded Item creation already accepts native data. Validate current installed D&D5e behavior before changing builders. |

## Adoption gates

For any selected fix, add a failing regression against the fork first, implement it within existing APIs, and verify that permissions, audit records, inverses, routing, and bounded responses survive. Test real Foundry for token state, item actions, and system-generated fields. Upstream tests and PR statements are evidence for candidate behavior, not a substitute for local integration checks.
