/**
 * mgt2e actor-system payload normalisation
 *
 * Runs server-side (Node.js) before data reaches Foundry, working around
 * Electron's persistent ES-module cache that prevented browser-side
 * normalisation from taking effect across sessions.
 */

import { CHARACTERISTIC_NAMES } from './constants.js';

/**
 * Skills that have named specialities in mgt2e.
 * The first entry in each array is the *primary* speciality used when
 * expanding a bare number shorthand (e.g. `{ pilot: 2 }`).
 * Source: Mongoose-Publishing/traveller-foundryvtt — config.mjs MGT2.SKILLS
 */
export const MGT2E_SKILL_SPECS: Record<string, string[]> = {
  animals: ['handling', 'vetinary', 'training'], // 'vetinary' is the module's own spelling
  art: ['performer', 'holography', 'instrument', 'visualMedia', 'write'],
  athletics: ['dexterity', 'endurance', 'strength'],
  drive: ['hovercraft', 'mole', 'track', 'walker', 'wheel'],
  electronics: ['comms', 'computers', 'remoteOps', 'sensors'],
  engineer: ['mDrive', 'jDrive', 'lifeSupport', 'power'],
  flyer: ['airship', 'grav', 'ornithopter', 'rotor', 'wing'],
  gunner: ['turret', 'ortillery', 'screen', 'capital'],
  guncombat: ['archaic', 'energy', 'slug'],
  heavyweapons: ['artillery', 'portable', 'vehicle'],
  language: ['galanglic', 'vilani', 'zdetl', 'oynprith', 'trokh', 'gvegh'],
  melee: ['unarmed', 'blade', 'bludgeon', 'natural'],
  pilot: ['smallCraft', 'spacecraft', 'capitalShips'],
  profession: [
    'belter',
    'biologicals',
    'civilEngineering',
    'construction',
    'hydroponics',
    'polymers',
    'robotics',
  ],
  science: [
    'archaeology',
    'astronomy',
    'biology',
    'chemistry',
    'cosmology',
    'cybernetics',
    'economics',
    'genetics',
    'history',
    'linquistics',
    'philosophy',
    'physics',
    'planetology',
    'psionicology',
    'psychology',
    'robotics',
    'sophontology',
    'xenology',
  ],
  seafarer: ['oceanShips', 'personal', 'sail', 'submarine'],
  tactics: ['military', 'naval'],
};

/**
 * Normalize mgt2e skill keys and expand shorthands before sending to Foundry.
 *
 * SIMPLE SKILLS (admin, carouse, stealth, …):
 *   mgt2e DataModel requires `id` to store value; otherwise level stays 0.
 *   `{ admin: 3 }`          →  `{ id:'admin', value:3, trained:true }`
 *   `{ admin: {value:3} }`  →  `{ id:'admin', value:3 }`
 *
 * SPEC-SKILLS (guncombat, pilot, heavyweapons, …):
 *   _prepareDerivedData() overrides parent.value with min(active spec values).
 *   Number shorthand sets parent value AND the primary speciality.
 *   `{ pilot: 2 }`  →  `{ value:2, trained:true, specialities:{ smallCraft:{value:2,trained:true} } }`
 *   Object with specialities: spread-merged (adding id would corrupt the DataModel).
 *   Object without specialities: id injected so simple-skill level persists.
 */
export function normalizeMGT2eSkillsInSystem(system: Record<string, any>): Record<string, any> {
  const normalizeSpecValues = (specs: Record<string, any>): Record<string, any> => {
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(specs)) {
      result[k] = typeof v === 'number' ? { value: v, trained: v > 0 } : v;
    }
    return result;
  };

  const normalizeSkillEntry = (sk: string, sv: any): any => {
    const defaultSpecs = MGT2E_SKILL_SPECS[sk];
    const isSpecSkill = defaultSpecs !== undefined;
    if (typeof sv === 'number') {
      if (isSpecSkill) {
        return {
          value: sv,
          trained: sv > 0,
          specialities: { [defaultSpecs[0]]: { value: sv, trained: sv > 0 } },
        };
      } else {
        return { id: sk, value: sv, trained: sv > 0 };
      }
    } else if (sv && typeof sv === 'object') {
      if (sv.specialities && typeof sv.specialities === 'object') {
        return { ...sv, specialities: normalizeSpecValues(sv.specialities) };
      } else {
        return { id: (sv as any).id ?? sk, ...sv };
      }
    }
    return sv;
  };

  const normalizeCharacteristicEntry = (key: string, value: any): [string, any] => {
    const metadata = CHARACTERISTIC_NAMES[key.toLowerCase()];
    if (!metadata) return [key, value];

    if (typeof value === 'number') {
      return [metadata.short, { value, show: true }];
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return [
        metadata.short,
        {
          ...value,
          ...(typeof value.show === 'boolean' ? {} : { show: true }),
        },
      ];
    }
    return [metadata.short, value];
  };

  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(system)) {
    if (key === 'characteristics' && val && typeof val === 'object' && !Array.isArray(val)) {
      const normalized: Record<string, any> = {};
      for (const [characteristicKey, characteristicValue] of Object.entries(val)) {
        const [normalizedKey, normalizedValue] = normalizeCharacteristicEntry(
          characteristicKey,
          characteristicValue
        );
        normalized[normalizedKey] = normalizedValue;
      }
      result.characteristics = normalized;
    } else if (key.startsWith('characteristics.-=')) {
      const requestedKey = key.slice('characteristics.-='.length);
      const normalizedKey = CHARACTERISTIC_NAMES[requestedKey.toLowerCase()]?.short ?? requestedKey;
      result[`characteristics.-=${normalizedKey}`] = val;
    } else if (key.startsWith('characteristics.')) {
      const rest = key.slice('characteristics.'.length);
      const dotIndex = rest.indexOf('.');
      const requestedKey = dotIndex === -1 ? rest : rest.slice(0, dotIndex);
      const normalizedKey = CHARACTERISTIC_NAMES[requestedKey.toLowerCase()]?.short ?? requestedKey;
      if (dotIndex === -1) {
        const [, normalizedValue] = normalizeCharacteristicEntry(requestedKey, val);
        result[`characteristics.${normalizedKey}`] = normalizedValue;
      } else {
        result[`characteristics.${normalizedKey}${rest.slice(dotIndex)}`] = val;
      }
    } else if (key === 'skills' && val && typeof val === 'object' && !Array.isArray(val)) {
      const normalized: Record<string, any> = {};
      for (const [sk, sv] of Object.entries(val as Record<string, any>)) {
        const lk = sk.toLowerCase();
        normalized[lk] = normalizeSkillEntry(lk, sv);
      }
      result['skills'] = normalized;
    } else if (key.startsWith('skills.-=')) {
      result[`skills.-=${key.slice('skills.-='.length).toLowerCase()}`] = val;
    } else if (key.startsWith('skills.')) {
      const rest = key.slice('skills.'.length);
      const dotIdx = rest.indexOf('.');
      if (dotIdx === -1) {
        const skillKey = rest.toLowerCase();
        result[`skills.${skillKey}`] = normalizeSkillEntry(skillKey, val);
      } else {
        const skillKey = rest.substring(0, dotIdx).toLowerCase();
        const subPath = rest.substring(dotIdx);
        result[`skills.${skillKey}${subPath}`] = val;
      }
    } else {
      result[key] = val;
    }
  }
  return result;
}
