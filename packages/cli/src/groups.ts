import fs from 'node:fs';
import path from 'node:path';
import { globalDir, canonicalizePath, writeFileAtomic } from '@memory-layer/core';

/**
 * Groups of repositories that make up one system.
 *
 * A group is a list of project paths and nothing more: no copy of their
 * contents, no second index. Every answer about a group is computed from the
 * members' own stores at the moment it is asked, so a group cannot go stale on
 * its own -- only its members can, and they say so themselves.
 */

export interface Group {
  name: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

function groupsFile(): string {
  return path.join(globalDir(), 'groups.json');
}

export function readGroups(): Group[] {
  const file = groupsFile();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? (parsed as Group[]) : [];
  } catch {
    // Like the project registry: a group file is a list of locations, and a
    // corrupt one must not take the CLI down. Every group can be made again.
    return [];
  }
}

function writeGroups(groups: Group[]): void {
  fs.mkdirSync(globalDir(), { recursive: true });
  writeFileAtomic(groupsFile(), JSON.stringify(groups, null, 2));
}

export function findGroup(name: string): Group | undefined {
  return readGroups().find((group) => group.name === name);
}

export type GroupChange =
  | { status: 'ok'; group: Group; added: string[]; removed: string[] }
  | { status: 'not_found'; name: string; known: string[] }
  | { status: 'no_such_path'; paths: string[] };

/** Creates a group, or adds to one that exists. Paths must be real directories. */
export function upsertGroup(name: string, members: string[]): GroupChange {
  const missing = members.filter((member) => !fs.existsSync(member));
  if (missing.length > 0) return { status: 'no_such_path', paths: missing };

  const canonical = members.map((member) => canonicalizePath(path.resolve(member)));
  const groups = readGroups();
  const now = new Date().toISOString();
  const existing = groups.find((group) => group.name === name);

  if (!existing) {
    const group: Group = { name, members: [...new Set(canonical)], createdAt: now, updatedAt: now };
    groups.push(group);
    writeGroups(groups);
    return { status: 'ok', group, added: group.members, removed: [] };
  }

  const added = canonical.filter((member) => !existing.members.includes(member));
  existing.members = [...new Set([...existing.members, ...canonical])];
  existing.updatedAt = now;
  writeGroups(groups);
  return { status: 'ok', group: existing, added, removed: [] };
}

export function removeFromGroup(name: string, members: string[]): GroupChange {
  const groups = readGroups();
  const group = groups.find((entry) => entry.name === name);
  if (!group) return { status: 'not_found', name, known: groups.map((entry) => entry.name) };

  const canonical = members.map((member) => canonicalizePath(path.resolve(member)));
  const removed = group.members.filter((member) => canonical.includes(member));
  group.members = group.members.filter((member) => !canonical.includes(member));
  group.updatedAt = new Date().toISOString();
  writeGroups(groups);
  return { status: 'ok', group, added: [], removed };
}

export function deleteGroup(name: string): boolean {
  const groups = readGroups();
  const kept = groups.filter((group) => group.name !== name);
  if (kept.length === groups.length) return false;
  writeGroups(kept);
  return true;
}
