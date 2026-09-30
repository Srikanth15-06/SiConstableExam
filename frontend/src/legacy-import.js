export const LEGACY_MEMBERS_STORAGE_KEY = 'ts-police-ai-members-v1';
export const LEGACY_ACTIVE_MEMBER_STORAGE_KEY = 'ts-police-ai-active-member-v1';
export const LEGACY_ACTIVE_EMAIL_STORAGE_KEY = 'ts-police-ai-active-member-email-v1';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getBrowserStorage(storage) {
  if (storage) return storage;
  return typeof window === 'undefined' ? null : window.localStorage;
}

export function readLegacyMembers(storageArgument) {
  const storage = getBrowserStorage(storageArgument);
  if (!storage) return [];
  try {
    const raw = storage.getItem(LEGACY_MEMBERS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
    const unique = new Map();
    for (const member of Object.values(parsed)) {
      if (!member || typeof member !== 'object' || Array.isArray(member)
        || typeof member.id !== 'string' || typeof member.email !== 'string') continue;
      if (!unique.has(member.id)) unique.set(member.id, member);
    }
    return [...unique.values()];
  } catch {
    return [];
  }
}

export function removeImportedLegacyMember(member, storageArgument) {
  const storage = getBrowserStorage(storageArgument);
  if (!storage || !member || typeof member.id !== 'string' || typeof member.email !== 'string') return false;
  try {
    const raw = storage.getItem(LEGACY_MEMBERS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const next = { ...parsed };
    const selectedSnapshot = JSON.stringify(member);
    const matchingKeys = Object.entries(next)
      .filter(([, candidate]) => candidate?.id === member.id && normalizeEmail(candidate.email) === normalizeEmail(member.email));
    if (!matchingKeys.length || matchingKeys.some(([, candidate]) => JSON.stringify(candidate) !== selectedSnapshot)) return false;
    for (const [key] of matchingKeys) delete next[key];
    if (Object.keys(next).length) storage.setItem(LEGACY_MEMBERS_STORAGE_KEY, JSON.stringify(next));
    else storage.removeItem(LEGACY_MEMBERS_STORAGE_KEY);
    if (storage.getItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY) === member.id) storage.removeItem(LEGACY_ACTIVE_MEMBER_STORAGE_KEY);
    if (normalizeEmail(storage.getItem(LEGACY_ACTIVE_EMAIL_STORAGE_KEY)) === normalizeEmail(member.email)) storage.removeItem(LEGACY_ACTIVE_EMAIL_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}