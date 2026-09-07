# PotSpark normal match instances

## Public Play flow

1. The normal **Play** flow asks the server for a public match assignment before
   the map deploys.
2. The server places the player in the current open instance and balances them
   between **Team Crazies** and **Team Maddies**.
3. Each instance accepts at most ten players: five per team.
4. When the tenth player joins, that instance is sealed. The next player
   automatically creates and joins the next instance.
5. The same rule repeats for later players, so match 1, match 2, match 3, and so
   on remain isolated.

Normal matches allow join-in-progress until their tenth slot is filled. A full
match is never reopened after a disconnect; later players stay in the newer
instance instead of being moved between live games.

## Isolation and trust

- Clients cannot choose an instance id, team, player count, or match scope.
- A duplicate join request is idempotent and never consumes another slot.
- `ENTER_GAME` is rejected until the server has assigned a normal instance, or
  a private code room has passed its existing unanimous Ready gate.
- Public instances and private code rooms use the same proven world-scope
  boundary for snapshots, player visibility, combat, and friendly-fire rules.
- Disconnects remove the player from the allocator. Empty instances are
  deleted, while previously full instances stay sealed.
- Private six-character rooms remain separate and unchanged.

The allocator is intentionally in memory and fill-first. It needs no database
or separate game process for the current single-server prototype.

## Run and verify

```bash
npm ci
npm test
npm start
```

Open the lobby in eleven or more browser sessions and use normal **Play**. The
first ten players share one 5v5 instance; player eleven is assigned to the next
instance.
