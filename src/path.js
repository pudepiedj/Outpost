// A* on the tile grid (8-directional, no corner cutting, no cliff jumping) plus string-pulling.

export function createPathfinder(N) {
  const size = N * N;
  const g = new Float32Array(size);
  const came = new Int32Array(size);
  const open = new Uint32Array(size);    // generation stamp: node discovered
  const closed = new Uint32Array(size);  // generation stamp: node expanded
  let gen = 0;
  // binary heap of node ids keyed by f
  let heapIds = new Int32Array(1024), heapF = new Float64Array(1024), heapN = 0;

  function push(id, f) {
    if (heapN === heapIds.length) {
      const ni = new Int32Array(heapN * 2); ni.set(heapIds); heapIds = ni;
      const nf = new Float64Array(heapN * 2); nf.set(heapF); heapF = nf;
    }
    let i = heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapIds[i] = heapIds[p]; heapF[i] = heapF[p]; i = p;
    }
    heapIds[i] = id; heapF[i] = f;
  }
  function pop() {
    const top = heapIds[0];
    const lid = heapIds[--heapN], lf = heapF[heapN];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= heapN) break;
      if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
      if (heapF[c] >= lf) break;
      heapIds[i] = heapIds[c]; heapF[i] = heapF[c]; i = c;
    }
    heapIds[i] = lid; heapF[i] = lf;
    return top;
  }

  const DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

  // Returns a list of [x, y] waypoints (tile centres, last one possibly the exact goal) or null.
  function find(walk, elev, sx, sy, gx, gy, maxNodes = 14000) {
    let stx = Math.floor(sx), sty = Math.floor(sy);
    let gtx = Math.floor(gx), gty = Math.floor(gy);
    if (gtx < 0 || gty < 0 || gtx >= N || gty >= N) return null;
    const ok = (x, y) => x >= 0 && y >= 0 && x < N && y < N && walk[y * N + x];
    let exactGoal = true;
    if (!ok(gtx, gty)) {
      exactGoal = false;
      let best = null, bestD = Infinity;
      for (let r = 1; r <= 8 && !best; r++) {
        for (let y = gty - r; y <= gty + r; y++) for (let x = gtx - r; x <= gtx + r; x++) {
          if (Math.max(Math.abs(x - gtx), Math.abs(y - gty)) !== r || !ok(x, y)) continue;
          const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy) + 0.01 * Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
          if (d < bestD) { bestD = d; best = [x, y]; }
        }
      }
      if (!best) return null;
      [gtx, gty] = best;
    }
    if (stx === gtx && sty === gty) return [[exactGoal ? gx : gtx + 0.5, exactGoal ? gy : gty + 0.5]];

    gen++; heapN = 0;
    const start = sty * N + stx, goal = gty * N + gtx;
    const h = (x, y) => { const dx = Math.abs(x - gtx), dy = Math.abs(y - gty); return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    g[start] = 0; came[start] = -1; open[start] = gen; push(start, h(stx, sty));
    let bestNode = start, bestH = h(stx, sty), expanded = 0, found = false;
    while (heapN > 0) {
      const cur = pop();
      if (closed[cur] === gen) continue;
      closed[cur] = gen;
      if (cur === goal) { found = true; break; }
      if (++expanded > maxNodes) break;
      const cx = cur % N, cy = (cur / N) | 0;
      const hc = h(cx, cy);
      if (hc < bestH) { bestH = hc; bestNode = cur; }
      const ce = elev[cur];
      for (const [dx, dy, cost] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!ok(nx, ny)) continue;
        const n = ny * N + nx;
        if (Math.abs(elev[n] - ce) > 1) continue;
        if (dx && dy) {
          if (!ok(cx + dx, cy) || !ok(cx, cy + dy)) continue;
          if (Math.abs(elev[cy * N + cx + dx] - ce) > 1 || Math.abs(elev[(cy + dy) * N + cx] - ce) > 1) continue;
        }
        if (closed[n] === gen) continue;
        const ng = g[cur] + cost;
        if (open[n] === gen && ng >= g[n]) continue;
        open[n] = gen; g[n] = ng; came[n] = cur;
        push(n, ng + h(nx, ny) * 1.001);
      }
    }
    const end = found ? goal : bestNode;
    if (end === start) return null;
    const pts = [];
    for (let n = end; n !== start && n !== -1; n = came[n]) pts.push([n % N + 0.5, ((n / N) | 0) + 0.5]);
    pts.reverse();
    if (found && exactGoal) pts[pts.length - 1] = [gx, gy];
    return pts;
  }

  return { find };
}

// Can a unit walk in a straight line from (x0,y0) to (x1,y1)?
export function lineWalkable(walk, elev, N, x0, y0, x1, y1, halfWidth = 0.28) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  if (len < 1e-6) return true;
  const px = -dy / len * halfWidth, py = dx / len * halfWidth;
  const steps = Math.ceil(len / 0.25);
  for (const [ox, oy] of [[0, 0], [px, py], [-px, -py]]) {
    let prev = -1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const tx = Math.floor(x0 + dx * t + ox), ty = Math.floor(y0 + dy * t + oy);
      if (tx < 0 || ty < 0 || tx >= N || ty >= N) return false;
      const n = ty * N + tx;
      if (!walk[n]) return false;
      if (prev >= 0 && n !== prev && Math.abs(elev[n] - elev[prev]) > 1) return false;
      prev = n;
    }
  }
  return true;
}
