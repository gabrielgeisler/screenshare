const socket = io();

const authOverlay = document.getElementById('authOverlay');
const authForm = document.getElementById('authForm');
const authInput = document.getElementById('authInput');
const authError = document.getElementById('authError');
const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const unmuteBtn = document.getElementById('unmuteBtn');
const qualitySelect = document.getElementById('qualitySelect');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const remoteControls = document.getElementById('remoteControls');
const drawerToggle = document.getElementById('drawerToggle');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localBox = document.getElementById('localBox');
const remoteBox = document.getElementById('remoteBox');
const statusEl = document.getElementById('status');

const rtcConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
};

let localStream = null;
// Uma conexão por espectador, indexada pelo id do socket dele
const peerConnections = {};
// Conexão usada quando este cliente está assistindo a tela de outra pessoa
let watcherConnection = null;

const QUALITY_PRESETS = {
  high: { width: 1920, height: 1080, frameRate: 30 },
  medium: { width: 1280, height: 720, frameRate: 24 },
  low: { width: 854, height: 480, frameRate: 15 },
};

// ---------- Autenticação por senha (.env) ----------

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  socket.emit('auth', authInput.value, (response) => {
    if (response.success) {
      authOverlay.classList.add('hidden');
      shareBtn.disabled = false;
      qualitySelect.disabled = false;
      // Só passa a se anunciar como espectador depois de autenticado
      socket.emit('watcher');
    } else {
      authError.classList.remove('hidden');
      authInput.value = '';
    }
  });
});

// ---------- Quem compartilha a tela (broadcaster) ----------

shareBtn.addEventListener('click', async () => {
  try {
    const preset = QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.medium;
    // audio: true pede ao navegador para exibir a opção "Compartilhar áudio";
    // não é possível filtrar o áudio de um app específico (ex.: Discord) via API do navegador
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: true,
    });
    localVideo.srcObject = localStream;

    // Para automaticamente se o usuário parar pela barra do navegador
    localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);

    socket.emit('broadcaster');
    shareBtn.disabled = true;
    stopBtn.disabled = false;
    qualitySelect.disabled = true;
    localBox.classList.remove('hidden');
    remoteBox.classList.add('hidden');
    statusEl.textContent = 'Você está compartilhando sua tela.';
  } catch (err) {
    console.error('Erro ao capturar a tela:', err);
    statusEl.textContent = 'Não foi possível iniciar o compartilhamento.';
  }
});

stopBtn.addEventListener('click', stopSharing);

function stopSharing() {
  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
  }
  localVideo.srcObject = null;

  Object.values(peerConnections).forEach((pc) => pc.close());
  for (const id in peerConnections) delete peerConnections[id];

  shareBtn.disabled = false;
  stopBtn.disabled = true;
  qualitySelect.disabled = false;
  localBox.classList.add('hidden');
  statusEl.textContent = 'Compartilhamento encerrado.';
}

socket.on('watcher', (watcherId) => {
  if (!localStream) return;

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[watcherId] = pc;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('candidate', watcherId, event.candidate);
    }
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => socket.emit('offer', watcherId, pc.localDescription));
});

socket.on('answer', (watcherId, description) => {
  const pc = peerConnections[watcherId];
  if (pc) pc.setRemoteDescription(description);
});

socket.on('watcher-disconnected', (watcherId) => {
  const pc = peerConnections[watcherId];
  if (pc) {
    pc.close();
    delete peerConnections[watcherId];
  }
});

// ---------- Quem assiste a tela (watcher) ----------

socket.on('offer', (broadcasterId, description) => {
  watcherConnection = new RTCPeerConnection(rtcConfig);

  watcherConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteBox.classList.remove('hidden');
    localBox.classList.add('hidden');
    document.body.classList.add('watching');
    statusEl.textContent = 'Assistindo à tela compartilhada.';
    // Sempre exibe o botão de som; áudio/vídeo podem chegar em eventos separados,
    // então não dá para confiar em getAudioTracks() no primeiro disparo do ontrack
    unmuteBtn.classList.remove('hidden');
    // Alguns navegadores (ex.: aba anônima) bloqueiam o autoplay; força o play manualmente
    remoteVideo.play().catch((err) => console.warn('Falha ao iniciar o vídeo automaticamente:', err));
  };

  watcherConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('candidate', broadcasterId, event.candidate);
    }
  };

  watcherConnection
    .setRemoteDescription(description)
    .then(() => watcherConnection.createAnswer())
    .then((answer) => watcherConnection.setLocalDescription(answer))
    .then(() => socket.emit('answer', broadcasterId, watcherConnection.localDescription));
});

socket.on('candidate', (id, candidate) => {
  const pc = peerConnections[id] || watcherConnection;
  if (pc) pc.addIceCandidate(new RTCIceCandidate(candidate));
});

socket.on('broadcaster', () => {
  socket.emit('watcher');
});

socket.on('broadcaster-disconnected', () => {
  remoteVideo.srcObject = null;
  remoteBox.classList.add('hidden');
  unmuteBtn.classList.add('hidden');
  document.body.classList.remove('watching');
  statusEl.textContent = 'O compartilhamento de tela foi encerrado.';
});

unmuteBtn.addEventListener('click', () => {
  remoteVideo.muted = false;
  remoteVideo.play().catch((err) => console.warn('Falha ao ativar o som:', err));
  unmuteBtn.classList.add('hidden');
});

fullscreenBtn.addEventListener('click', () => {
  // Coloca a caixa (vídeo + botões) em tela cheia, não só o vídeo, para os controles continuarem visíveis
  if (remoteBox.requestFullscreen) {
    remoteBox.requestFullscreen().catch((err) => console.warn('Falha ao entrar em tela cheia:', err));
  }
});

drawerToggle.addEventListener('click', () => {
  remoteControls.classList.toggle('open');
});
