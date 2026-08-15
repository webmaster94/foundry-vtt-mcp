/**
 * Tests for mgt2e skill normalisation.
 *
 * `normalizeMGT2eSkillsInSystem` runs on the MCP server (Node.js) before data
 * is sent to Foundry, working around Electron's persistent ES-module cache that
 * prevented browser-side normalisation from taking effect.
 */

import { describe, it, expect } from 'vitest';
import { normalizeMGT2eSkillsInSystem, MGT2E_SKILL_SPECS } from './normalize.js';

// ─── MGT2E_SKILL_SPECS sanity ──────────────────────────────────────────────

describe('MGT2E_SKILL_SPECS', () => {
  it('lists pilot as a spec-skill with smallCraft as primary speciality', () => {
    expect(MGT2E_SKILL_SPECS['pilot'][0]).toBe('smallCraft');
  });

  it('lists guncombat as a spec-skill with archaic as primary speciality', () => {
    expect(MGT2E_SKILL_SPECS['guncombat'][0]).toBe('archaic');
  });

  it('uses the module spelling "vetinary" (not "veterinary") for animals', () => {
    expect(MGT2E_SKILL_SPECS['animals']).toContain('vetinary');
    expect(MGT2E_SKILL_SPECS['animals']).not.toContain('veterinary');
  });

  it('lists language as a spec-skill with galanglic as primary speciality', () => {
    expect(MGT2E_SKILL_SPECS['language'][0]).toBe('galanglic');
  });

  it('lists profession as a spec-skill with belter as primary speciality', () => {
    expect(MGT2E_SKILL_SPECS['profession'][0]).toBe('belter');
  });

  it('lists science as a spec-skill with archaeology as primary speciality', () => {
    expect(MGT2E_SKILL_SPECS['science'][0]).toBe('archaeology');
  });

  it('does not list admin (simple skill)', () => {
    expect(MGT2E_SKILL_SPECS['admin']).toBeUndefined();
  });
});

// ─── normalizeMGT2eSkillsInSystem ─────────────────────────────────────────

describe('normalizeMGT2eSkillsInSystem', () => {
  // ── simple skills ────────────────────────────────────────────────────────

  it('expands a simple-skill number shorthand with id', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { admin: 3 } });
    expect(result.skills.admin).toEqual({ id: 'admin', value: 3, trained: true });
  });

  it('marks trained:false when simple-skill level is 0', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { stealth: 0 } });
    expect(result.skills.stealth).toEqual({ id: 'stealth', value: 0, trained: false });
  });

  it('injects id into a simple-skill object that lacks one', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { medic: { value: 2 } } });
    expect(result.skills.medic).toEqual({ id: 'medic', value: 2 });
  });

  it('preserves a pre-existing id in a simple-skill object', () => {
    const result = normalizeMGT2eSkillsInSystem({
      skills: { admin: { id: 'admin', value: 3, trained: true } },
    });
    expect(result.skills.admin).toEqual({ id: 'admin', value: 3, trained: true });
  });

  // ── spec-skills ───────────────────────────────────────────────────────────

  it('expands a spec-skill number shorthand with primary speciality and parent value', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { pilot: 2 } });
    expect(result.skills.pilot).toEqual({
      value: 2,
      trained: true,
      specialities: { smallCraft: { value: 2, trained: true } },
    });
  });

  it('expands spec-skill shorthand level 0 with trained:false', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { guncombat: 0 } });
    expect(result.skills.guncombat).toEqual({
      value: 0,
      trained: false,
      specialities: { archaic: { value: 0, trained: false } },
    });
  });

  it('expands heavyweapons shorthand using artillery as primary speciality', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { heavyweapons: 3 } });
    expect(result.skills.heavyweapons).toEqual({
      value: 3,
      trained: true,
      specialities: { artillery: { value: 3, trained: true } },
    });
  });

  it('normalises numeric speciality values inside an explicit specialities object', () => {
    const result = normalizeMGT2eSkillsInSystem({
      skills: {
        pilot: {
          value: 0,
          trained: true,
          specialities: { spacecraft: 3, smallCraft: 1 },
        },
      },
    });
    expect(result.skills.pilot.specialities).toEqual({
      spacecraft: { value: 3, trained: true },
      smallCraft: { value: 1, trained: true },
    });
  });

  it('preserves already-object speciality values unchanged', () => {
    const input = {
      skills: {
        pilot: {
          value: 0,
          specialities: { spacecraft: { value: 3, trained: true } },
        },
      },
    };
    const result = normalizeMGT2eSkillsInSystem(input);
    expect(result.skills.pilot.specialities.spacecraft).toEqual({ value: 3, trained: true });
  });

  it('does NOT inject id into a spec-skill object that has specialities (avoids DataModel corruption)', () => {
    const result = normalizeMGT2eSkillsInSystem({
      skills: {
        guncombat: { value: 2, trained: true, specialities: { slug: { value: 2, trained: true } } },
      },
    });
    expect(result.skills.guncombat.id).toBeUndefined();
  });

  it('injects id into a spec-skill object WITHOUT specialities (level persists correctly)', () => {
    const result = normalizeMGT2eSkillsInSystem({
      skills: { pilot: { value: 2, trained: true } },
    });
    expect(result.skills.pilot.id).toBe('pilot');
  });

  // ── key case normalisation ────────────────────────────────────────────────

  it('lowercases MixedCase skill keys', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { GunCombat: 3 } });
    expect(result.skills['guncombat']).toBeDefined();
    expect(result.skills['GunCombat']).toBeUndefined();
  });

  it('treats a lowercased key that matches a spec-skill correctly', () => {
    const result = normalizeMGT2eSkillsInSystem({ skills: { PILOT: 1 } });
    expect(result.skills['pilot']).toMatchObject({ value: 1, trained: true });
    expect(result.skills['pilot'].specialities).toBeDefined();
  });

  // ── dot-notation keys (Foundry flat update paths) ─────────────────────────

  it('normalises a simple flat skill entry as well as its key', () => {
    const result = normalizeMGT2eSkillsInSystem({ 'skills.Admin': 5 });
    expect(result['skills.admin']).toEqual({ id: 'admin', value: 5, trained: true });
    expect(result['skills.Admin']).toBeUndefined();
  });

  it('expands a flat specialization skill shorthand', () => {
    const result = normalizeMGT2eSkillsInSystem({ 'skills.Pilot': 2 });
    expect(result['skills.pilot']).toEqual({
      value: 2,
      trained: true,
      specialities: { smallCraft: { value: 2, trained: true } },
    });
  });

  it('preserves sub-path casing after the skill key in dot-notation', () => {
    const result = normalizeMGT2eSkillsInSystem({ 'skills.pilot.specialities.spacecraft': 3 });
    expect(result['skills.pilot.specialities.spacecraft']).toBe(3);
  });

  it('passes through a deletion key (skills.-=) unchanged', () => {
    const result = normalizeMGT2eSkillsInSystem({ 'skills.-=admin': null });
    expect(result['skills.-=admin']).toBeNull();
  });

  // ── characteristics ──────────────────────────────────────────────────────

  it('normalises lowercase characteristic shorthand to the DataModel shape', () => {
    const result = normalizeMGT2eSkillsInSystem({
      characteristics: { str: 8, dex: 9, end: 7 },
    });
    expect(result.characteristics).toEqual({
      STR: { value: 8, show: true },
      DEX: { value: 9, show: true },
      END: { value: 7, show: true },
    });
  });

  it('preserves explicit characteristic options while normalising the key', () => {
    const result = normalizeMGT2eSkillsInSystem({
      characteristics: { psi: { value: 11, show: false } },
    });
    expect(result.characteristics).toEqual({ PSI: { value: 11, show: false } });
  });

  it('normalises whole-entry and nested dotted characteristic updates', () => {
    const result = normalizeMGT2eSkillsInSystem({
      'characteristics.str': 10,
      'characteristics.dex.value': 9,
    });
    expect(result).toEqual({
      'characteristics.STR': { value: 10, show: true },
      'characteristics.DEX.value': 9,
    });
  });

  // ── non-skills keys ───────────────────────────────────────────────────────

  it('passes unrelated non-skills keys through without modification', () => {
    const chars = { STR: { value: 8, show: true } };
    const sophont = { homeworld: 'Regina' };
    const result = normalizeMGT2eSkillsInSystem({
      characteristics: chars,
      skills: { admin: 1 },
      sophont,
    });
    expect(result.characteristics).toEqual(chars);
    expect(result.sophont).toBe(sophont);
  });

  it('returns an empty object unchanged', () => {
    expect(normalizeMGT2eSkillsInSystem({})).toEqual({});
  });

  // ── multiple skills in one call ───────────────────────────────────────────

  it('normalises a mixed bag of simple and spec-skills without cross-contamination', () => {
    const result = normalizeMGT2eSkillsInSystem({
      skills: { admin: 3, pilot: 2, stealth: 1 },
    });
    expect(result.skills.admin).toEqual({ id: 'admin', value: 3, trained: true });
    expect(result.skills.pilot.specialities.smallCraft).toEqual({ value: 2, trained: true });
    expect(result.skills.stealth).toEqual({ id: 'stealth', value: 1, trained: true });
    // No id on spec-skill
    expect(result.skills.pilot.id).toBeUndefined();
  });
});
