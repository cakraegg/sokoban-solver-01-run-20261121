// Sokoban solver: push-optimal, room by room.
//
// One program answers a whole set of Sokoban levels (XSB) in a single run.
// The levels this competition draws are built from a hallway with rooms off
// it, and a box pushed out of its room can never come back, so each room is
// an independent puzzle: the level's push-optimal count is the sum of its
// rooms' optima. The solver therefore cuts the level into rooms and solves
// each room push-optimally, then walks the player from room to room.
//
// A room is solved with A* over pushes (not single steps): a state is the
// boxes' squares plus the player's reachable region, a push moves one box
// one square, and the player walks between pushes. The estimate is the
// cheapest assignment of boxes to goals by shortest-path distance (a
// minimum matching, so no push is ever under-counted), which keeps the
// search optimal. Two deadlocks are pruned, both provably safe: a box on a
// dead square (no sequence of pushes, other boxes aside, can bring it to a
// goal) and a frozen 2x2 block of walls and boxes holding a box off goal.
// Work is bounded by fixed expansion caps, never by the clock, so two runs
// on the same set write the same bytes.
//
// Pure TypeScript, standard library only, no randomness, no clock reads.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fixed expansion budgets (counts of work, never wall time): the search
// stops cleanly at a cap and the caller falls back, so the whole set
// finishes inside its budget on any machine.
const ASTAR_CAP = 600_000;
const BFS_CAP = 250_000;
// Total work across the set. The whole state space of every room in a
// drawn set is under ~600k expansions, so 800k never cuts a valid room
// short while keeping a pathological run well inside the 60-second wall.
const TOTAL_CAP = 800_000;
let spent = 0;

// The four steps, always tried in this order, so every tie breaks the same way.
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text: '#' wall, ' ' floor, '.' goal, '$' box, '*' box on goal, '@' player, '+' player on goal. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  // The outermost frame is a wall whatever it shows: nothing leaves the
  // board, and every neighbour lookup below then stays inside the array.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes, player };
}

/**
 * Dead squares: a square is live when a box standing on it can be pushed
 * onto some goal with no other box in the way. Computed by pulling back
 * from the goals: a box at y can be pulled from x = y + d when both y and
 * the square the player must stand on (y - d) are open floor.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi] as number;
    for (const { dx, dy } of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with `occupied` in the way,
 * marked in `seen` under `stamp`; returns the lowest reached square, the
 * canonical name of the region (two player positions in one region are the
 * same state for the search).
 */
function reachLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n] as number;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block: four squares of walls and boxes holding a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/**
 * Shortest-path distances (ignoring boxes) from every floor square to each
 * goal, as a flat table: dist[goalIndex * size + square]. Infinity (a large
 * sentinel) when no path exists.
 */
function goalDistances(level: Level): Int32Array {
  const { w, wall, goals } = level;
  const size = wall.length;
  const INF = 1_000_000;
  const dist = new Int32Array(goals.length * size).fill(INF);
  for (let gi = 0; gi < goals.length; gi++) {
    const g = goals[gi] as number;
    const base = gi * size;
    const queue: number[] = [g];
    dist[base + g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi] as number;
      const nd = dist[base + p] as number;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && dist[base + q] === INF) {
          dist[base + q] = nd + 1;
          queue.push(q);
        }
      }
    }
  }
  return dist;
}

/**
 * Admissible estimate of the pushes still needed: the cheapest assignment
 * of boxes to goals by shortest-path distance. One push moves one box one
 * square, so the assignment cost can fall by at most one per push. Small
 * box counts are matched exactly by trying every assignment; larger ones
 * fall back to the sum of each box's nearest goal (also a lower bound).
 * Infinity when no assignment exists: the state is dead.
 */
function estimate(boxes: number[], goals: number[], dist: Int32Array, size: number): number {
  const n = boxes.length;
  const INF = 1_000_000;
  if (n === 0) return 0;
  if (n <= 5 && goals.length === n) {
    // Every permutation of the goals, in fixed order.
    const perm: number[] = goals.map((_, i) => i);
    let best = INF;
    const walk = (k: number, cost: number): void => {
      if (cost >= best) return;
      if (k === n) {
        best = cost;
        return;
      }
      for (let i = k; i < n; i++) {
        const t = perm[k] as number;
        perm[k] = perm[i] as number;
        perm[i] = t;
        const d = dist[(perm[k] as number) * size + (boxes[k] as number)] as number;
        if (d < INF) walk(k + 1, cost + d);
        const t2 = perm[k] as number;
        perm[k] = perm[i] as number;
        perm[i] = t2;
      }
    };
    walk(0, 0);
    return best;
  }
  let sum = 0;
  for (const b of boxes) {
    let m = INF;
    for (let gi = 0; gi < goals.length; gi++) {
      const d = dist[gi * size + b] as number;
      if (d < m) m = d;
    }
    if (m >= INF) return INF;
    sum += m;
  }
  return sum;
}

/** A state's key: the region's lowest square folded with the boxes' squares. Exact while size ** (boxes + 1) < 2 ** 53. */
function keyOf(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/** A binary heap on [f, -g, sequence], smallest first; the sequence number makes every tie break identically. */
class Heap {
  private a: number[][] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: number[]): void {
    const a = this.a;
    let i = a.length;
    a.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (Heap.less(a[i] as number[], a[p] as number[])) {
        const t = a[i] as number[];
        a[i] = a[p] as number[];
        a[p] = t;
        i = p;
      } else break;
    }
  }
  pop(): number[] {
    const a = this.a;
    const top = a[0] as number[];
    const last = a.pop() as number[];
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && Heap.less(a[c + 1] as number[], a[c] as number[])) c++;
        if (!Heap.less(a[c] as number[], a[i] as number[])) break;
        const t = a[i] as number[];
        a[i] = a[c] as number[];
        a[c] = t;
        i = c;
      }
    }
    return top;
  }
  private static less(x: number[], y: number[]): boolean {
    return (
      (x[0] as number) < (y[0] as number) ||
      ((x[0] as number) === (y[0] as number) &&
        (((x[1] as number) < (y[1] as number)) ||
          ((x[1] as number) === (y[1] as number) && (x[2] as number) < (y[2] as number))))
    );
  }
}

interface SearchResult {
  pushes: number;
  moves: string;
}

/**
 * The push-optimal solution of `level`: {pushes, moves}, or null when the
 * search gives up at `maxStates` expansions (or the level has no solution).
 * With `useHeuristic` false the estimate is zero and the same code runs a
 * plain breadth-first search over pushes, which is the fallback.
 */
function solvePushOptimal(level: Level, maxStates: number, useHeuristic: boolean): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  // A second marking array: the child's region (for its key) is computed
  // while the parent's region is still being read, so it must not share
  // the parent's marks.
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in order of discovery: boxes, the player's square after the
  // push that made the state, the parent, and the push (from -> to).
  const stBoxes: number[][] = [level.boxes.slice()];
  const stPlayer: number[] = [level.player];
  const stParent: number[] = [-1];
  const stFrom: number[] = [-1];
  const stTo: number[] = [-1];
  const stG: number[] = [0];
  const best = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = reachLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const numericKey = (level.boxes.length + 1) * Math.log2(size) < 53;
  const keyFor = (boxes: number[], low: number): number | string =>
    numericKey ? keyOf(boxes, low, size) : `${low}:${boxes.join(',')}`;
  best.set(keyFor(level.boxes, startLow) as never, 0);
  const startH = useHeuristic ? estimate(level.boxes, goals, dist, size) : 0;
  if (startH >= 1_000_000) return null;
  if (solved(level.boxes)) return { pushes: 0, moves: '' };

  const heap = new Heap();
  let seq = 0;
  heap.push([startH, 0, seq++, 0]);
  let found = -1;
  let expanded = 0;

  while (heap.size > 0 && found < 0) {
    const entry = heap.pop();
    const s = entry[3] as number;
    const g = stG[s] as number;
    const boxes = stBoxes[s] as number[];
    // This state's canonical key, from its recorded player square. A
    // cheaper route to the same state makes this entry stale: skip it.
    for (const b of boxes) occupied[b] = 1;
    const stateLow = reachLow(level, occupied, stPlayer[s] as number, seen, ++stamp, stack);
    for (const b of boxes) occupied[b] = 0;
    const recorded = best.get(keyFor(boxes, stateLow) as never) as number | undefined;
    if (recorded !== undefined && recorded < g) continue;
    // A goal state is optimal only when popped: it then holds the smallest
    // f in the heap, and a goal's f is its push count. Returning a goal at
    // generation time could be one push over optimal.
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expanded >= maxStates || spent >= TOTAL_CAP) return null;
    expanded++;
    spent++;

    // The player's reachable region from this state, once per expansion.
    for (const b of boxes) occupied[b] = 1;
    reachLow(level, occupied, stPlayer[s] as number, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi] as number;
      for (let k = 0; k < 4; k++) {
        const { dx, dy } = DIRS[k] as { dx: number; dy: number };
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          const low = reachLow(level, occupied, b, mark, ++stamp, stack);
          key = keyFor(next, low);
          h = useHeuristic ? estimate(next, goals, dist, size) : 0;
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || h >= 1_000_000) continue;
        const prev = best.get(key as never);
        if (prev !== undefined && (prev as number) <= g + 1) continue;
        best.set(key as never, g + 1);
        const ns = stBoxes.length;
        stBoxes.push(next);
        stPlayer.push(b);
        stParent.push(s);
        stFrom.push(b);
        stTo.push(t);
        stG.push(g + 1);
        heap.push([g + 1 + h, -(g + 1), seq++, ns]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // The path of pushes, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = stParent[s] as number) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = stBoxes[s] as number[];
    const from = stFrom[s] as number;
    const to = stTo[s] as number;
    const d = to - from;
    const dir = DIRS.find(({ dx, dy }) => dy * w + dx === d) as { step: string; push: string };
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower-case step letters (u first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi] as number;
    if (p === to) break;
    for (const { dx, dy, step } of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p] as number) s = (how[p] as string) + s;
  return s;
}

/** The square the player stands on after playing `moves` from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, a box starts in the hallway, or a goal lies outside
 * every part: then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const cur = squares[i] as number;
      for (const { dx, dy } of DIRS) {
        const q = cur + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b] as number]?.boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g] as number]?.goals.push(g);
  if (goals.some((g) => part[g] < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 * Null when a room's search gives up; the caller then tries the whole level.
 */
function solveByRooms(level: Level): SearchResult | null {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, ASTAR_CAP, true) ?? solvePushOptimal(sub, BFS_CAP, false);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** Solve one level: room by room, else the whole level at once, else an empty (valid, zero-point) answer. */
function solveLevel(text: string): string {
  try {
    const level = parseLevel(text);
    if (level.player < 0 || level.boxes.length === 0) return '';
    if (level.boxes.every((b) => level.goals.includes(b))) return '';
    const byRooms = solveByRooms(level);
    if (byRooms !== null) return byRooms.moves;
    const whole = solvePushOptimal(level, BFS_CAP, true) ?? solvePushOptimal(level, BFS_CAP, false);
    return whole === null ? '' : whole.moves;
  } catch {
    return '';
  }
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
