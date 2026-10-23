import { config } from './config.js';
import { createApp } from './app.js';
import { pool } from './db/pool.js';

const { server, game, io, telnet } = await createApp();
game.startAmbient();

server.listen(config.port, () => {
  console.log(`Gallowmere listening on port ${config.port}`);
});

async function shutdown() {
  console.log('Shutting down');
  game.stop();
  io.close();
  telnet?.close();
  server.close();
  await pool.end().catch(() => undefined);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
