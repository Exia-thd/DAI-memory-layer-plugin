import fs from 'node:fs';
import { storeDirOrThrow } from './project.js';

/**
 * Removing a project's store.
 *
 * Everything in it that a scan produced can be rebuilt by `init`. What cannot
 * is what a person wrote: decisions, incidents, constraints. So this refuses
 * without an explicit `--yes`, and says what is about to be lost rather than
 * asking a question nobody reads.
 */
export type CleanResult =
  | { status: 'removed'; dir: string }
  | { status: 'refused'; dir: string; reason: string };

export function cleanStore(options: { confirmed: boolean; from?: string }): CleanResult {
  const dir = storeDirOrThrow(options.from);
  if (!options.confirmed) {
    return {
      status: 'refused',
      dir,
      reason: 'this removes the store, including everything recorded by hand that no scan can rebuild. Pass --yes to do it.',
    };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: 'removed', dir };
}
