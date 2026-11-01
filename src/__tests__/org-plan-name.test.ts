import { describe, expect, it } from 'vitest';
import { orgPlanName } from '../handlers/instances.js';

// Neue Organisationen tragen die Id `team` (api org_repository.go) — das ist der kostenlose
// Grundstand, seit 31.10./01.11.2026 sind Team und Business Brain-Stufen.
describe('orgPlanName', () => {
  it('zeigt den Grundstand als Free, nicht als die 49-Euro-Stufe Team', () => {
    expect(orgPlanName('team')).toBe('Free');
    expect(orgPlanName('free')).toBe('Free');
  });

  it('zeigt bezahlte Altplaene und Enterprise mit Namen', () => {
    expect(orgPlanName('business')).toBe('Business');
    expect(orgPlanName('enterprise')).toBe('Enterprise');
  });

  it('schreibt Unbekanntes gross und behandelt Leeres als Free', () => {
    expect(orgPlanName('custom')).toBe('Custom');
    expect(orgPlanName('')).toBe('Free');
  });
});
