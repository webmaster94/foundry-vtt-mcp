# Piano implementazione: tool `dnd5e-create-npc`

## Contesto

Repository: `adambdooley/foundry-vtt-mcp` (fork locale in
`C:\Users\lucam\Documents\Progetti\foundry-vtt-mcp`)

Stack:

- `packages/mcp-server/` — Node.js MCP server in TypeScript
- `packages/foundry-module/` — modulo Foundry VTT (browser)
- `packages/shared/` — tipi condivisi (workspace dep)

Pattern architetturale a 4 layer (seguito da tutti i tool esistenti):

1. **Server tool class** (`mcp-server/src/tools/…`) — Zod validation, query dispatch
2. **Backend registration** (`mcp-server/src/backend.ts`) — import, instantiate, allTools, switch
3. **Query handler** (`foundry-module/src/queries.ts`) — GM check, validation, call data-access
4. **Data access** (`foundry-module/src/data-access.ts`) — Foundry API calls, Actor.create()

Tool precedente già implementato nello stesso stile: `dnd5e-add-feature-with-save`
in `packages/mcp-server/src/tools/dnd5e/feature.ts`.

---

## Tool da implementare

**Nome:** `dnd5e-create-npc`  
**Scope:** Crea un nuovo Actor di tipo "npc" in D&D 5e con stat block completo
"Level 2" (identità, HP, CA, ability scores, movement, senses, languages,
skills, saving throws, damage immunities/resistances/vulnerabilities, condition
immunities, CR, biography). **Nessun item/azione/feature/spell nell'Actor.**  
**Sistema:** solo dnd5e — `detectGameSystem()` guard come in `feature.ts`.

---

## 1. Schema input Zod completo

### Identità

| Campo             | Tipo           | Req | Default | Validazione                                                                                                                                    |
| ----------------- | -------------- | --- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | string         | ✅  | —       | min 1                                                                                                                                          |
| `creatureType`    | enum           | ✅  | —       | humanoid / undead / beast / dragon / aberration / construct / elemental / fey / fiend / giant / monstrosity / ooze / plant / celestial / swarm |
| `creatureSubtype` | string         | ❌  | `""`    | —                                                                                                                                              |
| `size`            | enum           | ✅  | —       | tiny / small / medium / large / huge / gargantuan                                                                                              |
| `alignment`       | string         | ❌  | `""`    | —                                                                                                                                              |
| `cr`              | string\|number | ✅  | —       | string: `/^\d+(\/(2\|4\|8))?$/`; number: finite ≥ 0                                                                                            |

### Stat block

| Campo          | Tipo     | Req | Default | Validazione                                               |
| -------------- | -------- | --- | ------- | --------------------------------------------------------- |
| `abilities`    | oggetto  | ✅  | —       | 6 chiavi: str/dex/con/int/wis/cha, ognuna int 1–30        |
| `savingThrows` | string[] | ❌  | `[]`    | ogni elemento in: str/dex/con/int/wis/cha                 |
| `hpAverage`    | int      | ✅  | —       | ≥ 1                                                       |
| `hpFormula`    | string   | ✅  | —       | min 1 (es. "2d6", "3d8+9") — non validato sintatticamente |

### CA — superRefine: `acValue` obbligatorio quando `acMode === "flat"`

| Campo     | Tipo | Req | Default | Validazione                            |
| --------- | ---- | --- | ------- | -------------------------------------- |
| `acMode`  | enum | ✅  | —       | "default" / "flat"                     |
| `acValue` | int  | ❌  | —       | 0–30 — obbligatorio se acMode==="flat" |

### Movimento

| Campo         | Tipo | Req | Default |
| ------------- | ---- | --- | ------- |
| `walkSpeed`   | int  | ❌  | `30`    |
| `flySpeed`    | int  | ❌  | `0`     |
| `swimSpeed`   | int  | ❌  | `0`     |
| `climbSpeed`  | int  | ❌  | `0`     |
| `burrowSpeed` | int  | ❌  | `0`     |
| `hover`       | bool | ❌  | `false` |

Tutti i campi velocità: ≥ 0.

### Sensi

| Campo           | Tipo   | Req | Default |
| --------------- | ------ | --- | ------- |
| `darkvision`    | int    | ❌  | `0`     |
| `blindsight`    | int    | ❌  | `0`     |
| `tremorsense`   | int    | ❌  | `0`     |
| `truesight`     | int    | ❌  | `0`     |
| `specialSenses` | string | ❌  | `""`    |

Tutti i campi distanza: ≥ 0.

### Competenze

| Campo    | Tipo  | Req | Default | Validazione                                                                |
| -------- | ----- | --- | ------- | -------------------------------------------------------------------------- |
| `skills` | array | ❌  | `[]`    | ogni elemento: `{ skill: SkillEnum, proficiency: "proficient"\|"expert" }` |

SkillEnum (18 valori): Acrobatics / Animal Handling / Arcana / Athletics /
Deception / History / Insight / Intimidation / Investigation / Medicine /
Nature / Perception / Performance / Persuasion / Religion / Sleight of Hand /
Stealth / Survival

### Traits

| Campo                   | Tipo     | Req | Default | Note                         |
| ----------------------- | -------- | --- | ------- | ---------------------------- |
| `damageImmunities`      | string[] | ❌  | `[]`    | soft validation (vedi sotto) |
| `damageResistances`     | string[] | ❌  | `[]`    | soft validation              |
| `damageVulnerabilities` | string[] | ❌  | `[]`    | soft validation              |
| `conditionImmunities`   | string[] | ❌  | `[]`    | soft validation              |
| `languages`             | string[] | ❌  | `[]`    | —                            |
| `languagesCustom`       | string   | ❌  | `""`    | —                            |

**Soft validation:** valori fuori dai set canonici non bloccano la creazione,
ma vengono raccolti in `warnings: string[]` nella risposta.

```
damageCanonical = [
  "acid", "bludgeoning", "cold", "fire", "force", "lightning",
  "necrotic", "piercing", "poison", "psychic", "radiant", "slashing", "thunder"
]
conditionCanonical = [
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned",
  "prone", "restrained", "stunned", "unconscious"
]
```

Per ogni valore non nel set canonico: `logger.warn(...)` e aggiungi stringa
a `warnings[]`. La creazione procede comunque.

### Biografia e source

| Campo         | Tipo   | Req | Default  | Validazione     |
| ------------- | ------ | --- | -------- | --------------- |
| `biography`   | string | ❌  | `""`     | —               |
| `sourceBook`  | string | ❌  | `""`     | —               |
| `sourcePage`  | string | ❌  | `""`     | —               |
| `sourceRules` | enum   | ❌  | `"2014"` | "2014" / "2024" |

---

## 2. Mapping input → `Actor.create()` data

```
Actor.create({
  name: data.name,
  type: "npc",
  folder: (await getOrCreateFolder('Foundry MCP Creatures', 'Actor'))?.id ?? null,
  system: {
    abilities: {
      str: { value: data.abilities.str, proficient: savingThrows.includes("str") ? 1 : 0 },
      dex: { value: data.abilities.dex, proficient: savingThrows.includes("dex") ? 1 : 0 },
      con: { value: data.abilities.con, proficient: savingThrows.includes("con") ? 1 : 0 },
      int: { value: data.abilities.int, proficient: savingThrows.includes("int") ? 1 : 0 },
      wis: { value: data.abilities.wis, proficient: savingThrows.includes("wis") ? 1 : 0 },
      cha: { value: data.abilities.cha, proficient: savingThrows.includes("cha") ? 1 : 0 }
    },
    attributes: {
      ac: acMode === "flat"
            ? { calc: "flat", flat: acValue }
            : { calc: "default" },          // ometti flat quando default
      hp: {
        value:   hpAverage,
        max:     hpAverage,
        temp:    0,
        tempmax: 0,
        formula: hpFormula
      },
      movement: {
        walk:    walkSpeed,
        fly:     flySpeed,
        swim:    swimSpeed,
        climb:   climbSpeed,
        burrow:  burrowSpeed,
        units:   "ft",
        hover:   hover,
        special: ""
      },
      senses: {
        darkvision:  darkvision,
        blindsight:  blindsight,
        tremorsense: tremorsense,
        truesight:   truesight,
        units:       "ft",
        special:     specialSenses
      }
    },
    details: {
      cr:        normalizeCR(cr),    // float: 0→0, "1/4"→0.25, "1/2"→0.5, …
      type: {
        value:   creatureType,
        subtype: creatureSubtype
      },
      alignment: alignment,
      biography: { value: biography, public: "" },
      source: {
        revision: 1,
        rules:    sourceRules,
        book:     sourceBook,
        page:     sourcePage,
        custom:   "",
        license:  ""
      }
    },
    traits: {
      size: SIZE_MAP[size],           // "small"→"sm", "medium"→"med", ecc.
      di:   { value: damageImmunities,       custom: "", bypasses: [] },
      dr:   { value: damageResistances,      custom: "", bypasses: [] },
      dv:   { value: damageVulnerabilities,  custom: "", bypasses: [] },
      ci:   { value: conditionImmunities,    custom: "" },
      languages: { value: languages, custom: languagesCustom, communication: {} }
    },
    skills: buildSkillsBlock(skills)
  }
})
```

### Helper: `normalizeCR(input: string | number): number`

```
"0"   → 0        "1/8"  → 0.125    "1/4" → 0.25
"1/2" → 0.5      "1"    → 1        "N"   → parseInt(N)
number → as-is (già float)
```

### Helper: `formatCR(value: number): string` (per response)

```
0     → "0"      0.125 → "1/8"     0.25 → "1/4"
0.5   → "1/2"    1     → "1"       N≥1  → String(Math.round(N))
```

### Helper: `SIZE_MAP`

```
tiny→"tiny"  small→"sm"  medium→"med"  large→"lg"  huge→"huge"  gargantuan→"grg"
```

### Helper: `buildSkillsBlock(skills: {skill, proficiency}[]): object`

- Mappa ogni `skill` al key Foundry (tabella sotto)
- Setta `{ value: proficiency === "expert" ? 2 : 1 }` per le skill presenti
- Skill assenti → non incluse (Foundry usa default 0)

```
Acrobatics→acr    Animal Handling→ani    Arcana→arc     Athletics→ath
Deception→dec     History→his            Insight→ins    Intimidation→itm
Investigation→inv Medicine→med           Nature→nat     Perception→prc
Performance→prf   Persuasion→per         Religion→rel   Sleight of Hand→slt
Stealth→ste       Survival→sur
```

### Proficiency bonus

**Non settare `system.attributes.prof`** — Foundry lo deriva automaticamente
dal CR. Confermato: non presente negli schema reali di Goblin (CR 1/4) e
Banshee (CR 4).

### Response shape

```typescript
{
  success: true,
  actor: {
    id: string,
    name: string,
    cr: string,        // formatCR(float) — es. "1/4", "4"
    folder: string | null
  },
  warnings: string[]   // vuoto se nessun valore fuori canonical
}
```

---

## 3. Decisioni di design confermate

| #   | Decisione                                                                                  |
| --- | ------------------------------------------------------------------------------------------ |
| 1   | `acValue` obbligatorio via `superRefine` solo quando `acMode === "flat"`                   |
| 2   | `flat` omesso dall'oggetto ac quando `acMode === "default"`                                |
| 3   | Soft validation per damage/condition values — warning non bloccante                        |
| 4   | `hpFormula` non validato sintatticamente — stringa non vuota                               |
| 5   | `attributes.prof` non settato — auto-derivato dal CR da Foundry                            |
| 6   | Saving throws: `abilities[x].proficient: 1` per le abilities in `savingThrows[]`           |
| 7   | Skills: solo le skill fornite incluse in `system.skills`, le altre al default              |
| 8   | `bypasses: []` incluso in di/dr/dv (come nello schema reale), ma non esposto in input (V1) |
| 9   | CR accetta string fraction ("1/4", "1/2") o number — normalizzato a float internamente     |
| 10  | Folder: `getOrCreateFolder('Foundry MCP Creatures', 'Actor')` — stesso degli altri tool    |
| 11  | `sourceRules` default `"2014"`                                                             |
| 12  | `detectGameSystem()` guard — errore se sistema non è dnd5e                                 |

---

## 4. File da creare / modificare (4 layer)

### Layer 1 — CREATE

**`packages/mcp-server/src/tools/dnd5e/npc.ts`**  
Nuova classe `DnD5eNpcTools`. Metodi:

- `getToolDefinitions()` → definizione tool con JSON Schema
- `handleCreateNpc(args)` → Zod parse → soft validation warnings → query dispatch → format response

### Layer 2 — MODIFY

**`packages/mcp-server/src/backend.ts`**  
4 touch point:

1. `import { DnD5eNpcTools } from './tools/dnd5e/npc.js';`
2. `const dnd5eNpcTools = new DnD5eNpcTools({ foundryClient, logger });` (dopo `dnd5eFeatureTools`)
3. `...dnd5eNpcTools.getToolDefinitions(),` in `allTools` (dopo la riga `dnd5eFeatureTools`)
4. `case 'dnd5e-create-npc':` nel blocco switch D&D 5e (dopo il case `dnd5e-add-feature-with-save`)

### Layer 3 — MODIFY

**`packages/foundry-module/src/queries.ts`**  
2 touch point:

1. In `registerHandlers()`: `CONFIG.queries[\`${modulePrefix}.createNpcActor\`] = this.handleCreateNpcActor.bind(this);`
2. Nuovo metodo privato `handleCreateNpcActor(data)`: GM check → validateFoundryState → validazione base (name, cr) → `this.dataAccess.createNpcActor(data)`

### Layer 4 — MODIFY

**`packages/foundry-module/src/data-access.ts`**  
Nuovo metodo pubblico `createNpcActor(data)`:

- `this.validateFoundryState()` (fuori dal try)
- System guard: `(game.system as any).id !== 'dnd5e'`
- `normalizeCR`, `buildSkillsBlock`, `SIZE_MAP` come funzioni/const locali nel file
- `await getOrCreateFolder('Foundry MCP Creatures', 'Actor')`
- `await Actor.create(actorData)`
- `auditLog` success/failure
- Return `{ success, actor: { id, name, cr: formatCR(...), folder }, warnings }`

---

## 5. Comandi di build e verifica

Dopo ogni layer, verificare TypeScript:

```bash
# Build shared prima (dipendenza workspace)
cd packages/shared && node_modules/.bin/tsc

# Verifica mcp-server (Layer 1 e 2)
cd packages/mcp-server && node_modules/.bin/tsc --noEmit

# Verifica foundry-module (Layer 3 e 4)
cd packages/foundry-module && node_modules/.bin/tsc --noEmit
```

Build finale con output:

```bash
cd packages/mcp-server && node_modules/.bin/tsc
cd packages/foundry-module && node_modules/.bin/tsc
```

---

## 6. Debito tecnico noto (non toccare in questa sessione)

- `dnd5e-add-feature-with-save` in `data-access.ts` hardcoda `source.rules: "2024"`.
  Andrà cambiato in `"2014"` o reso parametrico in un task separato.
