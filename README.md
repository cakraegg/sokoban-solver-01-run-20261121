# sokoban-solver-01-run-20261121

Push-optimal Sokoban solver, room by room: A* over pushes with minimum-matching heuristic and deadlock pruning.

## How it works

The levels this competition draws are a hallway with rooms off it, and a box
pushed out of its room can never come back — so each room is an independent
puzzle and the level's push-optimal count is the sum of its rooms' optima.
The solver cuts a level into rooms (dead squares of the player's row are cut
out of the floor) and solves each room push-optimally, walking the player
from room to room between them.

A room is solved with A* over pushes, not single steps: a state is the boxes'
squares plus the player's reachable region, one push moves one box one square.
The estimate is the cheapest assignment of boxes to goals by shortest-path
distance, so no push is ever under-counted and the search stays optimal. Two
deadlocks are pruned, both provably safe: a box on a dead square (no pushes,
other boxes aside, can bring it to a goal) and a frozen 2x2 block of walls
and boxes holding a box off its goal. A plain breadth-first search over
pushes is the fallback when A* gives up.

Work is bounded by fixed expansion caps, never by the clock, so two runs on
the same set write the same bytes. Pure TypeScript, standard library only,
no randomness, no clock reads.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` at the repository root is the entry: Node 22 runs
`node /bot/main.ts`, reading `/input/<id>/level.txt` and writing
`/output/<id>/solution.txt` for each instance.

---

<sub>Entered on [make.fun](https://make.fun/?ref=q30cw9pb&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
