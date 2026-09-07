import { createPotSparkServer } from "./server/runtime.js";

async function main() {
  console.info("[startup] indexing the authoritative map collider...");
  const app = await createPotSparkServer({
    onCollisionProgress: (percent, status) => {
      if (percent === 95 || percent === 99) console.info(`[startup] ${status} (${percent}%)`);
    },
  });
  const address = await app.start();
  const host = typeof address === "object" && address ? address.address : "127.0.0.1";
  const port = typeof address === "object" && address ? address.port : process.env.PORT || 5186;

  console.info("");
  console.info("PotSpark FPS - authoritative 5v5 instances, team rooms, movement + combat");
  console.info(`  Static files : http://${host}:${port}`);
  console.info(`  WebSocket    : ws://${host}:${port}/game`);
  console.info("  Simulation   : 60 Hz (server-owned)");
  console.info("  Snapshots    : 20 Hz");
  console.info("  Identity     : secure accounts + one-time match admission tickets");
  console.info("  Team rooms   : 6-character codes, switchable 5v5 teams, unanimous ready gate");
  console.info("  Normal match : fill-first 5v5 instances; player 11 rolls into the next lobby");
  console.info("  Combat       : ARC-7, Vesper, Recon, Breach (server-owned)");
  console.info("  Hit checks    : BVH occlusion + lag-compensated player hitboxes");
  console.info("");

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
  };
  process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
}

main().catch((error) => {
  console.error("[startup] fatal error", error);
  process.exitCode = 1;
});
