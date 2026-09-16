import { put, head } from '@vercel/blob';
import bcrypt from 'bcryptjs';

const MANIFEST_PATH = 'data/users.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getUsers() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

export async function saveUsers(users) {
  return put(MANIFEST_PATH, JSON.stringify(users, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function findUserByEmail(email) {
  const users = await getUsers();
  return users.find((u) => u.email.toLowerCase() === email.toLowerCase()) || null;
}

export async function findUserById(id) {
  const users = await getUsers();
  return users.find((u) => String(u.id) === String(id)) || null;
}

export async function findUserByCreatorId(creatorId) {
  const users = await getUsers();
  return users.find((u) => String(u.creatorId) === String(creatorId)) || null;
}

export async function createUser({ email, password, role, creatorId }) {
  const users = await getUsers();
  if (users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('An account with that email already exists');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const nextId = Math.max(0, ...users.map((u) => Number(u.id) || 0)) + 1;
  const user = {
    id: nextId,
    email,
    passwordHash,
    role,
    creatorId: creatorId ?? null,
    createdAt: new Date().toISOString(),
  };
  await saveUsers([...users, user]);
  return user;
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.passwordHash);
}

export function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
}

/** Fans don't have a username/handle field -- fall back to the local-part of their email so wall comments show a name instead of a raw ID. */
export function displayNameFor(user) {
  if (!user) return 'Someone';
  return user.displayName || String(user.email || '').split('@')[0] || 'Someone';
}
