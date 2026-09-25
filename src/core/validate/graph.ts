/** Cycle detection over parent links (bones -> bones, warps -> warps). */

/**
 * Cycles among `ids` following `parentOf` (links to ids outside the list are ignored). Each cycle is
 * listed starting at its member with the lowest index in `ids`; cycles are ordered by that index.
 */
export function findCycles(ids: readonly string[], parentOf: (id: string) => string | undefined): string[][] {
  const order = new Map<string, number>();
  ids.forEach((id, i) => {
    if (!order.has(id)) order.set(id, i);
  });
  const state = new Map<string, 'active' | 'done'>();
  const cycles: string[][] = [];
  for (const start of order.keys()) {
    const path: string[] = [];
    let cur: string | undefined = start;
    while (cur !== undefined && order.has(cur) && !state.has(cur)) {
      state.set(cur, 'active');
      path.push(cur);
      cur = parentOf(cur);
    }
    if (cur !== undefined && state.get(cur) === 'active') {
      const cycle = path.slice(path.indexOf(cur));
      let low = 0;
      for (let k = 1; k < cycle.length; k++) if (order.get(cycle[k])! < order.get(cycle[low])!) low = k;
      cycles.push([...cycle.slice(low), ...cycle.slice(0, low)]);
    }
    for (const id of path) state.set(id, 'done');
  }
  return cycles.sort((a, b) => order.get(a[0])! - order.get(b[0])!);
}
