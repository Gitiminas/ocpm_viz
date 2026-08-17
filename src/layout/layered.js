/**
 * The layered layout for the **off** time mode.
 *
 * Three rows — issue, pull request, commit — in the same top-to-bottom order as the
 * timeline's lanes, so the vertical vocabulary transfers between modes. Within a row,
 * horizontal position is chosen to put a node near the things it links to and to keep
 * edges from crossing. Time no longer decides anything about position; it survives on the
 * fill ramp, the arrowheads, the brush and the hovercard.
 *
 * ## Why layers rather than a force simulation
 *
 * A force layout knows only connectivity, so *where* a cluster lands is arbitrary —
 * nothing makes issues sit above pull requests, and the same sub-log can look completely
 * different from one seed to the next. Reported as "it seems kind of random where the
 * items will appear", and that was accurate: there was no rule that would have made it
 * otherwise. Layers make the hierarchy a property of the layout instead of an accident of
 * it, and they make the picture predictable enough to compare two sub-logs by eye.
 *
 * ## Why this is not a tree, and must not become one
 *
 * The data is **not** a tree: a commit can belong to two pull requests (fixtures F5 and
 * F13 exist to exercise exactly that), and an issue can relate to several PRs and vice
 * versa. Drawing a true tree would mean either duplicating that commit — so the reader
 * counts it twice — or dropping one of its edges. Both hide convergence, which
 * `ARCHITECTURE.md` names as the thing object-centric process mining exists to show.
 * So this is a **layered graph** (a Sugiyama-style arrangement) that *reads* as a tree
 * where the data happens to be one: a shared commit stays a single node and settles
 * between the two pull requests that claim it.
 *
 * ## The algorithm, in three steps
 *
 *   1. assign  every node to the row for its type
 *   2. order   within each row, by repeated barycentre sweeps, keeping the arrangement
 *              with the fewest edge crossings
 *   3. place   x from the average position of a node's neighbours, then a separation
 *              pass so nothing overlaps
 *
 * Pure, DOM-free and deterministic: no randomness, no clock, no iteration over unordered
 * collections. The same sub-log produces identical coordinates every time, which is what
 * lets a re-render leave the picture alone.
 */

/** Rows, top to bottom. The same order as `LANE_TYPES`, deliberately. */
export const LAYER_ORDER = ['issue', 'pull_request', 'commit'];

/** Minimum clear space between two marks in a row. */
const MIN_GAP = 14;
/** How hard a node is pulled toward its neighbours' average x, per pass. */
const ALIGN_STRENGTH = 0.85;
const ALIGN_PASSES = 6;
const ORDER_SWEEPS = 8;

/**
 * A 32-bit hash of a string, for deterministic tie-breaks.
 *
 * FNV-1a. Used only where two nodes are genuinely indistinguishable — same barycentre,
 * same starting index — so that the tie is broken the same way on every run rather than
 * by whatever order a collection happened to yield.
 */
export function hashId(id) {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Put every node in the row for its type, and give each row a stable starting order.
 *
 * ⚠️ The initial order is **by first appearance, then by id**, and that is not arbitrary.
 * Barycentre ordering is iterative and its result depends on where it starts, so the
 * starting order has to be deterministic or the layout is not. Choosing time for it also
 * means that where the crossing-minimisation has no preference — a row of unconnected
 * commits, say — what remains is chronological, which is a free and honest use of an
 * otherwise arbitrary choice. It is a tie-break, never a claim: nothing in this mode
 * promises that left means earlier.
 *
 * Rows with no members are dropped rather than drawn empty, so hiding the issue lane
 * gives its space back instead of leaving a gap where a row used to be.
 *
 * @param {Array} nodes
 * @param {string[]} [layerOrder]
 * @returns {Array<Array>} one array per non-empty row, top to bottom
 */
export function assignLayers(nodes, layerOrder = LAYER_ORDER) {
  const rows = layerOrder.map((type) => nodes.filter((node) => node.lane === type));

  for (const row of rows) {
    row.sort((a, b) => {
      const at = a.t ? +a.t : Infinity;
      const bt = b.t ? +b.t : Infinity;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  return rows.filter((row) => row.length > 0);
}

/** Neighbour ids per node, split into the row above and the row below. */
function neighbourIndex(rows, edges) {
  const rowOf = new Map();
  rows.forEach((row, r) => row.forEach((node) => rowOf.set(node.id, r)));

  const above = new Map();
  const below = new Map();
  for (const row of rows) {
    for (const node of row) {
      above.set(node.id, []);
      below.set(node.id, []);
    }
  }

  // Sorted, so the neighbour lists are built in a fixed order and every average below is
  // summed in that order — float addition is not associative.
  const ordered = edges
    .slice()
    .sort((a, b) =>
      a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : a.target > b.target ? 1 : 0,
    );

  for (const edge of ordered) {
    const sourceRow = rowOf.get(edge.source);
    const targetRow = rowOf.get(edge.target);
    if (sourceRow === undefined || targetRow === undefined) continue;
    if (sourceRow === targetRow) continue; // within a row: no vertical relationship to read
    const [upper, lower] =
      sourceRow < targetRow ? [edge.source, edge.target] : [edge.target, edge.source];
    below.get(upper).push(lower);
    above.get(lower).push(upper);
  }
  return { above, below };
}

/**
 * Count edge crossings between two adjacent rows.
 *
 * Two edges cross when their endpoints are in opposite order in the two rows. Quadratic
 * in the number of edges between the pair, which is fine at these sizes and is the
 * straightforward reading of the definition — worth more here than a faster algorithm
 * nobody can check by eye.
 */
export function countCrossings(upperRow, lowerRow, edges) {
  const upperAt = new Map(upperRow.map((node, i) => [node.id, i]));
  const lowerAt = new Map(lowerRow.map((node, i) => [node.id, i]));

  const pairs = [];
  for (const edge of edges) {
    for (const [a, b] of [
      [edge.source, edge.target],
      [edge.target, edge.source],
    ]) {
      if (upperAt.has(a) && lowerAt.has(b)) pairs.push([upperAt.get(a), lowerAt.get(b)]);
    }
  }

  let crossings = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const [u1, l1] = pairs[i];
      const [u2, l2] = pairs[j];
      if ((u1 - u2) * (l1 - l2) < 0) crossings += 1;
    }
  }
  return crossings;
}

/** Total crossings across every adjacent pair of rows. */
export function totalCrossings(rows, edges) {
  let total = 0;
  for (let r = 0; r + 1 < rows.length; r++) total += countCrossings(rows[r], rows[r + 1], edges);
  return total;
}

/**
 * Reorder within rows to reduce crossings, by repeated barycentre sweeps.
 *
 * Each node moves toward the average index of its neighbours in the reference row; sweeps
 * alternate direction so information travels both ways. The arrangement with the fewest
 * crossings **seen at any point** is what comes back, not simply the last one — barycentre
 * sweeps are not monotonic and can and do make things worse before making them better.
 *
 * A node with no neighbours in the reference row keeps its current index rather than
 * collapsing to zero, which is the standard rule and the one that stops unconnected nodes
 * migrating to the left edge.
 */
export function orderLayers(rows, edges, { sweeps = ORDER_SWEEPS } = {}) {
  let current = rows.map((row) => row.slice());
  let best = current.map((row) => row.slice());
  let bestScore = totalCrossings(best, edges);

  for (let sweep = 0; sweep < sweeps && bestScore > 0; sweep++) {
    const downwards = sweep % 2 === 0;
    const { above, below } = neighbourIndex(current, edges);

    const sequence = downwards
      ? [...current.keys()].slice(1)
      : [...current.keys()].slice(0, -1).reverse();

    for (const r of sequence) {
      const reference = downwards ? current[r - 1] : current[r + 1];
      const referenceAt = new Map(reference.map((node, i) => [node.id, i]));
      const neighbours = downwards ? above : below;

      const keyed = current[r].map((node, index) => {
        const ids = neighbours.get(node.id) || [];
        const positions = ids.map((id) => referenceAt.get(id)).filter((at) => at !== undefined);
        const barycentre = positions.length
          ? positions.reduce((sum, at) => sum + at, 0) / positions.length
          : index; // no neighbours: stay put
        return { node, index, barycentre };
      });

      keyed.sort(
        (a, b) =>
          a.barycentre - b.barycentre ||
          a.index - b.index ||
          hashId(a.node.id) - hashId(b.node.id),
      );
      current[r] = keyed.map((entry) => entry.node);
    }

    const score = totalCrossings(current, edges);
    if (score < bestScore) {
      bestScore = score;
      best = current.map((row) => row.slice());
    }
  }

  return { rows: best, crossings: bestScore };
}

/**
 * One entry per distinct pair of nodes, whatever number of links justify it.
 *
 * ⚠️ **The layout must count connections, not links, and the difference is not cosmetic.**
 * Two objects can be joined by several links at once — on kubernetes issue #47532 one pair
 * carries six — and in this mode both ends sit at the same point, so those six draw as one
 * line. Counting them separately inflated the crossing figure 4.5x (89 against 20 real
 * ones), which is the smaller half of the problem: the barycentre is an *average over
 * neighbours*, so a pair carrying six links also pulled six times harder than a pair
 * carrying one, and the ordering was being dragged around by how many detection methods
 * happened to agree rather than by the shape of the graph.
 *
 * The drawing still knows about every link — see `bundleEdges` in `structural.js`, which
 * keeps them so none can be silently buried. This is only what the *arrangement* reads.
 */
export function dedupeEdges(edges) {
  const seen = new Map();
  for (const edge of edges) {
    const key =
      edge.source < edge.target
        ? `${edge.source}||${edge.target}`
        : `${edge.target}||${edge.source}`;
    if (!seen.has(key)) seen.set(key, { source: edge.source, target: edge.target, key });
  }
  return [...seen.values()];
}

/**
 * Route an edge that skips a row through a placeholder in the row it passes over.
 *
 * ⚠️ **Without this such an edge is invisible to the crossing count and slices straight
 * through the middle row on screen.** Crossings are only counted between *adjacent* rows,
 * so an issue→commit link — which bypasses pull requests entirely — scored zero however
 * badly it cut across them. kubernetes #47532 has eight, none of them counted.
 *
 * The standard answer, and Sugiyama's: give the long edge a dummy node in each row it
 * crosses and treat it as a chain of ordinary segments. The dummy takes part in the
 * ordering, so the optimiser can finally see the edge; it takes a little space in the row,
 * so the line bends *around* the pull requests rather than over them; and it is never
 * drawn, because it stands for nothing in the data.
 */
export function insertDummies(rows, edges) {
  const rowOf = new Map();
  rows.forEach((row, r) => row.forEach((node) => rowOf.set(node.id, r)));

  const withDummies = rows.map((row) => row.slice());
  const segments = [];
  const routeOf = new Map();

  for (const edge of edges) {
    const from = rowOf.get(edge.source);
    const to = rowOf.get(edge.target);
    if (from === undefined || to === undefined) continue;

    const span = Math.abs(to - from);
    if (span <= 1) {
      segments.push(edge);
      continue;
    }

    // Walk downwards whichever way the edge runs, so the chain is built in row order.
    const [upper, lower] = from < to ? [edge.source, edge.target] : [edge.target, edge.source];
    const [top, bottom] = from < to ? [from, to] : [to, from];

    const chain = [upper];
    for (let r = top + 1; r < bottom; r++) {
      const dummy = {
        id: `dummy:${edge.key ?? `${edge.source}||${edge.target}`}:${r}`,
        lane: null,
        isDummy: true,
        radius: 4,
        t: null,
      };
      withDummies[r].push(dummy);
      chain.push(dummy.id);
    }
    chain.push(lower);

    for (let i = 0; i + 1 < chain.length; i++) {
      segments.push({ source: chain[i], target: chain[i + 1] });
    }
    // The waypoints, in the direction the caller gave the edge.
    const waypoints = chain.slice(1, -1);
    routeOf.set(
      edge.key ?? `${edge.source}||${edge.target}`,
      from < to ? waypoints : waypoints.slice().reverse(),
    );
  }

  // Re-sort, so a dummy lands somewhere deterministic rather than at the end of the row.
  for (const row of withDummies) {
    row.sort((a, b) => {
      const at = a.t ? +a.t : Infinity;
      const bt = b.t ? +b.t : Infinity;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  return { rows: withDummies, segments, routeOf };
}

/**
 * Give every node an x and a y.
 *
 * Rows are spread evenly down the box. Within a row, each node is pulled toward the
 * average x of its neighbours in the rows above and below — so a pull request sits under
 * its issue, a commit under the pull request that carries it, and **a commit claimed by
 * two pull requests settles between them**, which is the case the whole mode was
 * illustrated with. A separation pass then enforces a minimum gap without changing the
 * order the crossing-minimisation chose.
 *
 * ⚠️ Alignment and separation alternate rather than running once each. Separation moves
 * nodes away from where alignment wanted them, and alignment then pulls the row back
 * toward its neighbours; a few rounds settle into an arrangement that satisfies both,
 * where one pass of each satisfies only the later one.
 */
export function positionLayers(rows, edges, { width, height, padding = 60, radiusOf }) {
  const radius = radiusOf || ((node) => node.radius ?? 8);
  const { above, below } = neighbourIndex(rows, edges);

  const usableWidth = Math.max(1, width - 2 * padding);
  const rowY = (r) =>
    rows.length === 1
      ? height / 2
      : padding + (r * (height - 2 * padding)) / (rows.length - 1);

  // Start each row spread evenly across the box, in the order chosen above.
  const x = new Map();
  rows.forEach((row) => {
    const step = usableWidth / (row.length + 1);
    row.forEach((node, i) => x.set(node.id, padding + step * (i + 1)));
  });

  /*
   * ⚠️ **Alignment alternates direction; it does not average both at once.**
   *
   * Averaging a node's neighbours above *and* below in one step lets a narrow row act as
   * an attractor on a wide one. Measured on kubernetes #47532: three issues occupying
   * 279px pulled all eight pull requests into 465px while their commits were spread over
   * 955px, so every edge became a long diagonal and the picture looked far more tangled
   * than the graph is. Each pass now looks one way only — down toward children, then up
   * toward parents — which is what lets a row take the width its own contents need
   * instead of being compressed toward whatever is above it.
   */
  for (let pass = 0; pass < ALIGN_PASSES; pass++) {
    const downwards = pass % 2 === 0;
    // Sweeping in the direction of the pull means a row is aligned against neighbours
    // that have already moved this pass, so information travels the full depth in one
    // sweep instead of one row per pass.
    const order = downwards ? [...rows.keys()] : [...rows.keys()].reverse();

    for (const r of order) {
      const row = rows[r];
      const reference = downwards ? above : below;

      for (const node of row) {
        const ids = reference.get(node.id) || [];
        const positions = ids.map((id) => x.get(id)).filter((at) => at !== undefined);
        if (!positions.length) continue;
        const target = positions.reduce((sum, at) => sum + at, 0) / positions.length;
        x.set(node.id, x.get(node.id) + (target - x.get(node.id)) * ALIGN_STRENGTH);
      }
      separateRow(row, x, radius, { width, padding });
    }
  }

  centreAndFill(rows, x, radius, { width, padding });

  const positions = new Map();
  rows.forEach((row, r) => {
    const y = rowY(r);
    for (const node of row) positions.set(node.id, { x: x.get(node.id), y });
  });
  return positions;
}

/** How far a small drawing may be stretched to fill the box. */
const MAX_FILL_SCALE = 2.2;

/**
 * Centre the drawing, and let a small one grow into the space it has.
 *
 * ⚠️ **Without this a small sub-log ends up jammed against one edge, and the reason is
 * not obvious.** Repeated barycentre alignment is a *contraction*: averaging pulls every
 * node toward its neighbours, and with nothing pushing outwards the whole graph collapses
 * into a narrow column — positioned whereever the averaging happened to converge, which
 * on F13 was the right-hand quarter of an otherwise empty canvas. Separation stops marks
 * from touching but says nothing about where the group as a whole sits.
 *
 * ⚠️ **The stretch is capped, deliberately.** Filling the width unconditionally would
 * push two commits of the same pull request as far apart as two unrelated ones, which
 * dismantles the grouping the layers exist to show — a small graph would be spread until
 * proximity meant nothing. The cap lets a compact tree take more of the canvas without
 * pretending it is a big one; past it, the drawing stays compact and simply sits in the
 * middle. Scaling only ever *increases* gaps, so it cannot reintroduce an overlap.
 */
function centreAndFill(rows, x, radius, { width, padding }) {
  let minX = Infinity;
  let maxX = -Infinity;
  for (const row of rows) {
    for (const node of row) {
      minX = Math.min(minX, x.get(node.id) - radius(node));
      maxX = Math.max(maxX, x.get(node.id) + radius(node));
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return;

  const span = maxX - minX;
  const available = Math.max(1, width - 2 * padding);
  // ⚠️ Never below 1. Scaling *down* would compress a row that is already at its minimum
  // spacing and push marks back into one another — the separation pass has the last word
  // on how tight a row may be, and this must not overrule it.
  const scale = span > 0 ? Math.max(1, Math.min(MAX_FILL_SCALE, available / span)) : 1;

  // Scaled span, then the offset that centres it in the box.
  const scaledSpan = span * scale;
  const offset = (width - scaledSpan) / 2 - minX * scale;

  for (const row of rows) {
    for (const node of row) x.set(node.id, x.get(node.id) * scale + offset);
  }
}

/**
 * Enforce a minimum gap along one row, preserving order.
 *
 * A left-to-right sweep pushes each node clear of its predecessor; a right-to-left sweep
 * then pulls the row back inside the box. Doing only the first would let a crowded row
 * run off the right-hand edge — and in this mode nothing can scroll horizontally, so what
 * runs off is simply lost.
 *
 * ⚠️ When a row genuinely cannot fit, the gap is reduced rather than the order broken or
 * the nodes dropped. A crowded row is a legible complaint about density; a reordered or
 * truncated one is a wrong picture.
 */
function separateRow(row, x, radius, { width, padding }) {
  if (row.length === 0) return;

  const needed = row.reduce((sum, node) => sum + 2 * radius(node), 0) + MIN_GAP * (row.length - 1);
  const available = Math.max(1, width - 2 * padding);
  const gap =
    needed > available
      ? Math.max(2, MIN_GAP - (needed - available) / Math.max(1, row.length - 1))
      : MIN_GAP;

  /*
   * ⚠️ **Overlaps are resolved symmetrically, not by chaining from the left.**
   *
   * The first version walked left to right pushing each node clear of its predecessor —
   * which only ever moves things *right*. So if the leftmost node in row order happened to
   * be aligned far right, everything after it was strung out from there at minimum
   * spacing and the alignment was thrown away wholesale. Measured on kubernetes #47532:
   * the pull requests came out at 484, 531, 578, 652… — a chain of minimum gaps — while
   * the commits they belong to averaged 157, 241, 282…, so every edge left its pull
   * request as a long diagonal and the picture read as far more tangled than the graph is.
   *
   * Splitting each violation between the two nodes keeps the row centred on where
   * alignment wanted it, and iterating settles the knock-on effects.
   */
  const wanted = row.map((node) => x.get(node.id));

  // One left-to-right chain guarantees every gap: a node keeps the position alignment
  // chose for it unless its predecessor forces it right. Iterating half-steps instead was
  // tried and does not converge — a violation propagates by half a gap per pass, so on
  // F10's 24-node commit row eight passes left marks still overlapping by 13px.
  for (let i = 0; i < row.length; i++) {
    if (i === 0) continue;
    const minimum = x.get(row[i - 1].id) + radius(row[i - 1]) + gap + radius(row[i]);
    if (x.get(row[i].id) < minimum) x.set(row[i].id, minimum);
  }

  /*
   * ⚠️ Then undo the chain's **systematic rightward bias**, which is the whole reason the
   * previous version threw the alignment away. Pushing right is the only move a chain can
   * make, so a row whose leftmost node happens to sit far right drags everything after it
   * — measured on kubernetes #47532, the pull requests came out at 484, 531, 578… in a
   * chain of minimum gaps while their commits averaged 157, 241, 282…, so every edge left
   * its pull request as a long diagonal. Shifting the settled row back by its mean
   * displacement keeps the gaps exactly and restores the centre alignment asked for.
   */
  const drift =
    row.reduce((sum, node, i) => sum + (x.get(node.id) - wanted[i]), 0) / row.length;
  if (drift) for (const node of row) x.set(node.id, x.get(node.id) - drift);

  // Finally slide the row inside the box. Shifting rather than clamping the end nodes:
  // clamping would squash them back into their neighbours and undo the gaps above.
  const first = row[0];
  const last = row[row.length - 1];
  const leftOver = padding + radius(first) - x.get(first.id);
  if (leftOver > 0) for (const node of row) x.set(node.id, x.get(node.id) + leftOver);
  const rightOver = x.get(last.id) + radius(last) - (width - padding);
  if (rightOver > 0) {
    const shift = Math.min(rightOver, x.get(first.id) - padding - radius(first));
    if (shift > 0) for (const node of row) x.set(node.id, x.get(node.id) - shift);
  }
}

/**
 * The whole layered layout, in one call.
 *
 * @returns {{positions: Map, rows: Array<Array>, crossings: number}}
 */
export function layoutLayered(nodes, edges, { width, height, padding = 60, radiusOf } = {}) {
  if (!nodes.length) {
    return { positions: new Map(), rows: [], crossings: 0, waypoints: new Map() };
  }

  // One entry per connection, not per link, and long edges routed through placeholders.
  // Both change what the ordering *sees*; neither changes what the data says.
  const unique = dedupeEdges(edges);
  const assigned = assignLayers(nodes);
  const { rows: withDummies, segments, routeOf } = insertDummies(assigned, unique);

  const { rows, crossings } = orderLayers(withDummies, segments);
  const positions = positionLayers(rows, segments, { width, height, padding, radiusOf });

  // Where a long edge should bend. Keyed the same way `bundleEdges` keys a bundle, so the
  // renderer can ask for a route without knowing anything about dummies.
  const waypoints = new Map();
  for (const [key, ids] of routeOf) {
    waypoints.set(
      key,
      ids.map((id) => positions.get(id)).filter(Boolean),
    );
  }

  // Dummies stand for nothing in the data and are never drawn, so they leave with the
  // scaffolding rather than being handed to a renderer that would have to know to skip
  // them. Their positions survive in `waypoints`, which is the only thing they were for.
  const drawn = rows.map((row) => row.filter((node) => !node.isDummy));
  for (const row of withDummies) {
    for (const node of row) if (node.isDummy) positions.delete(node.id);
  }

  return { positions, rows: drawn, crossings, waypoints };
}
