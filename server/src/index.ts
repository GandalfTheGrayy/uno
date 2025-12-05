import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { mountStatic } from './httpStatic.js';
import { setupRooms } from './rooms.js';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3110;

const app = express();
app.use(cors());
mountStatic(app);

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*'}
});

io.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong'));
});
setupRooms(io);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`UNO server listening on :${PORT}`);
});


