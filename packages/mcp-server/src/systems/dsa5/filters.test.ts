/**
 * DSA5 Filter Tests
 *
 * Validates filter matching, description rendering, and validation helpers
 * against representative DSA5 creature data.
 */

import { describe, it, expect } from 'vitest';
import {
  matchesDSA5Filters,
  describeDSA5Filters,
  isValidDSA5Species,
  isValidExperienceLevel,
} from './filters.js';
import type { DSA5Filters } from './filters.js';

const goblin = {
  id: 'test-goblin-1',
  name: 'Goblin Krieger',
  type: 'character',
  systemData: {
    level: 2,
    species: 'goblin',
    culture: 'Bergstamm',
    size: 'small',
    hasSpells: false,
    experiencePoints: 1200,
  },
};

const elfMagier = {
  id: 'test-magier-1',
  name: 'Elf Magier',
  type: 'character',
  systemData: {
    level: 5,
    species: 'elf',
    culture: 'Auelfen',
    size: 'medium',
    hasSpells: true,
    experiencePoints: 4000,
  },
};

describe('matchesDSA5Filters', () => {
  it('matches exact level', () => {
    const filter: DSA5Filters = { level: 2 };
    expect(matchesDSA5Filters(goblin, filter)).toBe(true);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(false);
  });

  it('matches level range', () => {
    const filter: DSA5Filters = { level: { min: 2, max: 5 } };
    expect(matchesDSA5Filters(goblin, filter)).toBe(true);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(true);
  });

  it('matches species', () => {
    const filter: DSA5Filters = { species: 'goblin' };
    expect(matchesDSA5Filters(goblin, filter)).toBe(true);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(false);
  });

  it('matches hasSpells flag', () => {
    const filter: DSA5Filters = { hasSpells: true };
    expect(matchesDSA5Filters(goblin, filter)).toBe(false);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(true);
  });

  it('matches combined filters', () => {
    const filter: DSA5Filters = {
      level: { min: 1, max: 3 },
      size: 'small',
      hasSpells: false,
    };
    expect(matchesDSA5Filters(goblin, filter)).toBe(true);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(false);
  });

  it('matches experience-points range', () => {
    const filter: DSA5Filters = { experiencePoints: { min: 1000, max: 2000 } };
    expect(matchesDSA5Filters(goblin, filter)).toBe(true);
    expect(matchesDSA5Filters(elfMagier, filter)).toBe(false);
  });
});

describe('describeDSA5Filters', () => {
  it('returns a non-empty string for a populated filter', () => {
    const filter: DSA5Filters = { level: 2, species: 'goblin' };
    const description = describeDSA5Filters(filter);
    expect(typeof description).toBe('string');
    expect(description.length).toBeGreaterThan(0);
  });
});

describe('validation helpers', () => {
  it('isValidDSA5Species recognises known species', () => {
    expect(isValidDSA5Species('goblin')).toBe(true);
  });

  it('isValidDSA5Species rejects unknown species', () => {
    expect(isValidDSA5Species('unicorn')).toBe(false);
  });

  it('isValidExperienceLevel accepts levels 1-7', () => {
    expect(isValidExperienceLevel(3)).toBe(true);
    expect(isValidExperienceLevel(1)).toBe(true);
    expect(isValidExperienceLevel(7)).toBe(true);
  });

  it('isValidExperienceLevel rejects out-of-range values', () => {
    expect(isValidExperienceLevel(0)).toBe(false);
    expect(isValidExperienceLevel(8)).toBe(false);
  });
});
