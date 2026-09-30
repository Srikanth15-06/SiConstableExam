import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_ACTIVE_EMAIL_STORAGE_KEY,
  LEGACY_ACTIVE_MEMBER_STORAGE_KEY,
  LEGACY_MEMBERS_STORAGE_KEY,
  readLegacyMembers,
  removeImportedLegacyMember
} from './legacy-import.js';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

test('legacy candidate detection deduplicates the old id and email aliases', () => {
  const member = { id: 'member_1730000000000_ab12cd', name: 'Candidate', email: 'candidate@example.test', passwordSalt: 'salt', passwordHash: 'hash' };
  const storage = createStorage({ [LEGACY_MEMBERS_STORAGE_KEY]: JSON.stringify({ [member.id]: member, [member.email]: member }) });
  const candidates = readLegacyMembers(storage);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].email, member.email);
});

test('legacy cleanup removes only the imported member after exact snapshot match', () => {
  const candidateA = { id: 'member_1730000000000_ab12cd', name: 'A', email: 'a@example.test', passwordSalt: 'a', passwordHash: 'a' };
  const candidateB = { id: 'member_1730000000001_cd34ef', name: 'B', email: 'b@example.test', passwordSalt: 'b', passwordHash: 'b' };
  const storage = createStorage({
    [LEGACY_MEMBERS_STORAGE_KEY]: JSON.stringify({ [candidateA.id]: candidateA, [candidateA.email]: candidateA, [candidateB.id]: candidateB, [candidateB.email]: candidateB }),
    [LEGACY_ACTIVE_MEMBER_STORAGE_KEY]: candidateA.id,
    [LEGACY_ACTIVE_EMAIL_STORAGE_KEY]: candidateA.email
  });

  assert.equal(removeImportedLegacyMember(candidateA, storage), true);
  assert.deepEqual(readLegacyMembers(storage).map((member) => member.id), [candidateB.id]);
  assert.equal(storage.getItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY), null);
  assert.equal(storage.getItem(LEGACY_ACTIVE_EMAIL_STORAGE_KEY), null);
});

test('legacy cleanup preserves a record changed in another tab', () => {
  const submitted = { id: 'member_1730000000000_ab12cd', name: 'Candidate', email: 'candidate@example.test', passwordHash: 'old' };
  const newer = { ...submitted, userProgress: { Percentages: { attempts: 2 } } };
  const storage = createStorage({ [LEGACY_MEMBERS_STORAGE_KEY]: JSON.stringify({ [submitted.id]: newer, [submitted.email]: newer }) });
  assert.equal(removeImportedLegacyMember(submitted, storage), false);
  assert.equal(readLegacyMembers(storage).length, 1);
});