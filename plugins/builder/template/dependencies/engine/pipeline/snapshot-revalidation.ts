// Revalidating saved pages without an agent. `explore snapshot` takes the one snapshot per page that revalidation needs with
// tools/aria-snapshot.ts (navigation only), and this module decides what that snapshot is allowed to prove.
//
// The bar is the same as for an agent's snapshot - saved evidence counts as revalidated only after a snapshot from THIS run shows
// every locator the plan needs exactly once - plus two protections an agent's judgment would otherwise provide:
//  - The page the browser landed on must be the page that was asked for. A redirect to a login page, an error page or another route
//    proves nothing about the saved page, so it is never compared against the saved locators.
//  - A snapshot of a page that was only loaded (no clicks, no input) cannot show what appears after an interaction. A locator that is
//    not found is therefore "inconclusive", never "stale": nothing is invalidated and the page is left for the explorer, who can
//    reach the state and call `explore revalidate` (the only path that invalidates).
// Only a page whose needed locators are all `present` is committed, and only its `present` elements are recorded.

import { checkElements, type ElementCheck } from './exploration-reuse.ts';
import { pageKey, type StoredPage } from './exploration-store.ts';

export interface SnapshotJob {
  key: string;
  url: string; // absolute
  out: string; // snapshot file to write
}

// One entry of the snapshot tool's batch output.
export interface SnapshotResult {
  key: string;
  ok: boolean;
  url: string | null; // where the browser ended up
  status: number | null;
  title: string | null;
  snapshot: string | null;
  error: string | null;
}

export function buildJobs(pages: { key: string; url: string }[], baseUrl: string, outFor: (key: string) => string): SnapshotJob[] {
  return pages.map((p) => ({ key: p.key, url: new URL(p.url, baseUrl).href, out: outFor(p.key) }));
}

// A file name for a page's snapshot (page keys contain slashes and may contain a hash route).
export const snapshotName = (key: string): string => `${key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'}.aria.yml`;

export type Judgement =
  | { commit: true; checks: Record<string, ElementCheck> }
  | {
    commit: false;
    reason: string;
    retry: boolean; // another snapshot after a longer settle might come out differently (the page may still have been rendering)
    notPresent: string[]; // needed locators that were not found exactly once
  };

export function judgeSnapshot(args: {
  key: string;
  baseUrl: string;
  result: SnapshotResult;
  page: StoredPage;
  needed: string[]; // locators the test cases waiting on this page rely on (empty = the page only has to be reachable)
  snapshotText: string;
}): Judgement {
  const { result } = args;
  const no = (reason: string, retry = false, notPresent: string[] = []): Judgement => ({ commit: false, reason, retry, notPresent });
  if (!result.ok || result.url === null) return no(`the page could not be opened${result.error ? `: ${result.error}` : ''}`);
  if (result.status !== null && result.status >= 400) return no(`the page answered HTTP ${result.status}`);
  const landed = pageKey(result.url, args.baseUrl);
  if (landed !== args.key) return no(`the browser landed on ${landed ?? result.url}, not ${args.key} (a login redirect or another route): not compared`);

  const all = checkElements(args.page, args.snapshotText);
  const notPresent = args.needed.filter((l) => all[l]?.state !== 'present');
  if (notPresent.length > 0) {
    const states = notPresent.map((l) => `${l} is ${all[l]?.state ?? 'not in the store'}`);
    // Only "missing" can be a page that had not finished rendering; ambiguous and unverifiable do not change with time.
    const retry = notPresent.every((l) => all[l]?.state === 'missing');
    return no(`${states.join('; ')} in a snapshot of the page as loaded; it may need an interaction to appear, so nothing was invalidated`, retry, notPresent);
  }
  return { commit: true, checks: Object.fromEntries(Object.entries(all).filter(([, c]) => c.state === 'present')) };
}
