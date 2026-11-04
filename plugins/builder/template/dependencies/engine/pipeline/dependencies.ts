// Dependencies between test cases: "TC-004 needs TC-003 to have run first" (it edits the project TC-003 created).
//
// The input states them (a "Depends on" column or label, or a precondition that names another case); nothing is guessed from
// the steps. This module is pure: it validates the graph and works out the chains that must run in order.
//
// A chain is a set of cases connected by dependencies. Playwright orders tests only inside one file, so a chain is generated
// inside ONE file in a serial group (`test.describe.serial`): the tests run in order on one worker, and when one fails the rest of
// the group is skipped instead of running against missing data. A chain whose cases come from several modules gets a file of
// its own ("chain-<first id>"); a chain inside one module stays in that module's file.

import { slugify } from './test-spec.ts';

export interface DependencyNode {
  id: string;
  module: string;
  moduleSlug: string;
  dependsOn?: readonly string[];
}

export interface DependencyChain {
  id: string; // the first case in run order; names the chain
  ids: string[]; // every member, prerequisites before the cases that need them
  modules: string[]; // module slugs involved
  crossModule: boolean;
}

export const CHAIN_MODULE_PREFIX = 'Chain ';

// Edges to cases that exist; an unknown id is reported by the parser (it cannot be ordered), never invented here.
function edges(nodes: readonly DependencyNode[]): Map<string, string[]> {
  const known = new Set(nodes.map((n) => n.id));
  const out = new Map<string, string[]>();
  for (const n of nodes) out.set(n.id, [...new Set(n.dependsOn ?? [])].filter((d) => known.has(d) && d !== n.id));
  return out;
}

// The ids that sit on a dependency cycle (including a case that depends on itself).
export function cycleMembers(nodes: readonly DependencyNode[]): Set<string> {
  const deps = edges(nodes);
  const selfLoop = new Set(nodes.filter((n) => (n.dependsOn ?? []).includes(n.id)).map((n) => n.id));
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const members = new Set<string>(selfLoop);
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      for (let w = stack.pop()!; ; w = stack.pop()!) {
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      if (scc.length > 1) for (const w of scc) members.add(w);
    }
  };
  for (const n of nodes) if (!index.has(n.id)) visit(n.id);
  return members;
}

// Chains with at least two members, in the order their first member appears in the input. Cases on a cycle have no valid
// order, so they are left out (the parser has already marked them as needing clarification).
export function buildChains(nodes: readonly DependencyNode[]): DependencyChain[] {
  const deps = edges(nodes);
  const cyclic = cycleMembers(nodes);
  const live = nodes.filter((n) => !cyclic.has(n.id));
  const liveIds = new Set(live.map((n) => n.id));
  const position = new Map(nodes.map((n, i) => [n.id, i]));

  // union-find over the dependency edges
  const parent = new Map<string, string>(live.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    for (let c = x; parent.get(c) !== r; ) { const next = parent.get(c)!; parent.set(c, r); c = next; }
    return r;
  };
  for (const n of live) for (const d of deps.get(n.id) ?? []) if (liveIds.has(d)) parent.set(find(n.id), find(d));

  const groups = new Map<string, DependencyNode[]>();
  for (const n of live) groups.set(find(n.id), [...(groups.get(find(n.id)) ?? []), n]);

  const chains: { chain: DependencyChain; firstInInput: number }[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = topologicalOrder(members, deps, position);
    const modules = [...new Set(ordered.map((n) => n.moduleSlug))];
    chains.push({
      chain: { id: ordered[0]!.id, ids: ordered.map((n) => n.id), modules, crossModule: modules.length > 1 },
      firstInInput: Math.min(...members.map((m) => position.get(m.id)!)),
    });
  }
  return chains.sort((a, b) => a.firstInInput - b.firstInInput).map((c) => c.chain);
}

// Prerequisites first; ties keep the order of the input so the result is stable.
function topologicalOrder(members: DependencyNode[], deps: Map<string, string[]>, position: Map<string, number>): DependencyNode[] {
  const inGroup = new Set(members.map((m) => m.id));
  const done = new Set<string>();
  const out: DependencyNode[] = [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const visit = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    for (const d of [...(deps.get(id) ?? [])].filter((x) => inGroup.has(x)).sort((a, b) => position.get(a)! - position.get(b)!)) visit(d);
    out.push(byId.get(id)!);
  };
  for (const m of [...members].sort((a, b) => position.get(a.id)! - position.get(b.id)!)) visit(m.id);
  return out;
}

export interface ChainLayout {
  module: string; // display name used for the test.describe of the chain's file
  moduleSlug: string; // file-name form
}

// Where a case is generated when its chain spans several modules: a file of its own. Cases of single-module chains and cases
// without dependencies keep their own module (absent from the map).
export function chainLayouts(nodes: readonly DependencyNode[]): Map<string, ChainLayout> {
  const out = new Map<string, ChainLayout>();
  for (const c of buildChains(nodes)) {
    if (!c.crossModule) continue;
    const layout: ChainLayout = { module: `${CHAIN_MODULE_PREFIX}${c.id}`, moduleSlug: slugify(`chain-${c.id}`) };
    for (const id of c.ids) out.set(id, layout);
  }
  return out;
}

// The chains that live in one generated file (its module's file, or the chain's own file): what the generator must wrap in a
// serial group, and what the reviewer checks.
export function chainsInLayoutModule(nodes: readonly DependencyNode[], layoutSlug: (n: DependencyNode) => string, slug: string): DependencyChain[] {
  const slugOf = new Map(nodes.map((n) => [n.id, layoutSlug(n)]));
  return buildChains(nodes).filter((c) => c.ids.every((id) => slugOf.get(id) === slug));
}
