require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SENHA = process.env.SENHA;
if (!SENHA) {
  console.error('Defina a variável SENHA no arquivo .env antes de iniciar o servidor.');
  process.exit(1);
}

app.use(express.static(path.join(__dirname, 'public')));

// Guarda o id de quem está compartilhando a tela no momento
let broadcasterId = null;

io.on('connection', (socket) => {
  socket.data.authenticated = false;

  // Valida a senha antes de liberar qualquer ação de transmissão/visualização
  socket.on('auth', (senhaDigitada, callback) => {
    const ok = senhaDigitada === SENHA;
    socket.data.authenticated = ok;
    callback({ success: ok });
  });

  // Quem inicia o compartilhamento vira o "broadcaster"
  socket.on('broadcaster', () => {
    if (!socket.data.authenticated) return;
    broadcasterId = socket.id;
    socket.broadcast.emit('broadcaster', broadcasterId);
  });

  // Um espectador avisa que quer assistir
  socket.on('watcher', () => {
    if (!socket.data.authenticated) return;
    if (broadcasterId) {
      socket.to(broadcasterId).emit('watcher', socket.id);
    }
  });

  // Repassa as mensagens de sinalização WebRTC entre os pares
  socket.on('offer', (targetId, description) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('offer', socket.id, description);
  });

  socket.on('answer', (targetId, description) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('answer', socket.id, description);
  });

  socket.on('candidate', (targetId, candidate) => {
    if (!socket.data.authenticated) return;
    socket.to(targetId).emit('candidate', socket.id, candidate);
  });

  socket.on('disconnect', () => {
    if (socket.id === broadcasterId) {
      broadcasterId = null;
      socket.broadcast.emit('broadcaster-disconnected');
    } else {
      socket.broadcast.emit('watcher-disconnected', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
