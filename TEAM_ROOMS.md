# PotSpark team rooms

## Player flow

1. Open the lobby and select **Team** beside **Mode**.
2. Choose **Create Room** to receive a new six-character invite code, or enter
   a friend's code under **Join Room**.
3. Players are assigned automatically to **Team Crazies** and **Team Maddies**.
4. Before deployment, use the button beneath either team to switch sides. A
   switch clears only your own Ready state so the new side must be confirmed.
5. Guests are labelled `Player 1`, `Player 2`, and so on in room join order.
6. Select **Ready Up**. The server starts deployment automatically only when at
   least two players are present, both teams have a player, and every room
   member is ready.

Rooms accept up to ten players, with five slots per team. The room code can be
copied directly from the room panel. A new securely randomized code containing
both letters and numbers is created every time a new room is made.

## Server rules

- Clients can request create, join, team switch, ready, and leave operations,
  but the server validates team capacity and owns the code, player number, room
  phase, and start time.
- Joining alternates players between the smaller teams, starting with Team
  Crazies.
- New joins are rejected after a match starts.
- Team switches are rejected after a match starts or when the destination team
  already has five players.
- `ENTER_GAME` is rejected for room members until unanimous readiness.
- World snapshots, remote players, and hit validation are isolated by room.
- Players on the same team cannot damage one another.
- Disconnects remove the player and delete an empty room.
- Frame size, protocol version, reserved bytes, code format, room capacity, and
  invalid traffic are validated on the server.
- Create, join, switch, ready, and leave operations share a server-side token
  bucket so room-action floods cannot spam broadcasts or brute-force codes at
  wire speed.

## Usernames

The current static build has no login backend, so players correctly appear as
`Player N`. `createPotSparkServer` accepts a trusted
`resolveAuthenticatedUsername(request)` integration hook. When a real login
service verifies a session and returns a username through that hook, the server
uses the verified username in place of the guest label. The browser is never
trusted to claim that it is logged in or to choose another user's name.

## Run and verify

```bash
npm ci
npm test
npm start
```

Open `http://127.0.0.1:5186` in two or more browser windows. Create a room in
the first window, join it from the others, and ready every player. Deployment
will begin for all windows together.
