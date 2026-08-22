const socket = io();

const shareBtn = document.getElementById('shareBtn');
const stopBtn = document.getElementById('stopBtn');
const volumeControl = document.getElementById('volumeControl');
const volumeIcon = document.getElementById('volumeIcon');
const volumeSlider = document.getElementById('volumeSlider');
const qualitySelect = document.getElementById('qualitySelect');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const remoteControls = document.getElementById('remoteControls');
const drawerToggle = document.getElementById('drawerToggle');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const localBox = document.getElementById('localBox');
const remoteBox = document.getElementById('remoteBox');
const statusEl = document.getElementById('status');
const nameOverlay = document.getElementById('nameOverlay');
const nameForm = document.getElementById('nameForm');
const nameInput = document.getElementById('nameInput');
const viewersBtn = document.getElementById('viewersBtn');
const viewersCount = document.getElementById('viewersCount');
const viewersPanel = document.getElementById('viewersPanel');
const viewersList = document.getElementById('viewersList');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

// ---------- Modo escuro ----------

const THEME_STORAGE_KEY = 'screenshare_theme';

function aplicarTema(escuro) {
  document.documentElement.classList.toggle('dark', escuro);
  themeIcon.textContent = escuro ? '☀️' : '🌙';
}

aplicarTema(document.documentElement.classList.contains('dark'));

themeToggle.addEventListener('click', () => {
  const escuro = !document.documentElement.classList.contains('dark');
  aplicarTema(escuro);
  localStorage.setItem(THEME_STORAGE_KEY, escuro ? 'dark' : 'light');
});

// TURN é essencial para quem está atrás de NAT/firewall restritivo, onde a
// conexão P2P direta via STUN falha; carregado do servidor antes de qualquer oferta
const rtcConfigPromise = fetch('/ice-servers')
  .then((res) => res.json())
  .catch((err) => {
    console.warn('Não foi possível carregar os ICE servers, usando padrão:', err);
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  });

let localStream = null;
// Uma conexão por espectador, indexada pelo id do socket dele
const peerConnections = {};
// Conexão usada quando este cliente está assistindo a tela de outra pessoa
let watcherConnection = null;
// Candidates ICE que chegam antes da remoteDescription estar pronta ficam aqui até poderem ser aplicados
const pendingCandidates = {};

function adicionarOuEnfileirarCandidate(id, pc, candidate) {
  if (pc && pc.remoteDescription && pc.remoteDescription.type) {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => console.warn('Erro ao adicionar candidate:', err));
  } else {
    (pendingCandidates[id] = pendingCandidates[id] || []).push(candidate);
  }
}

function esvaziarCandidatesPendentes(id, pc) {
  const fila = pendingCandidates[id];
  if (!fila || !fila.length) return;
  delete pendingCandidates[id];
  fila.forEach((candidate) => {
    pc.addIceCandidate(new RTCIceCandidate(candidate)).catch((err) => console.warn('Erro ao adicionar candidate em fila:', err));
  });
}

const QUALITY_PRESETS = {
  high: { width: 1920, height: 1080, frameRate: 30 },
  medium: { width: 1280, height: 720, frameRate: 24 },
  low: { width: 854, height: 480, frameRate: 15 },
};

// ---------- Autenticação ----------
// A senha já foi validada via HTTP Basic Auth antes de a página carregar,
// então basta liberar a UI e se anunciar como espectador
shareBtn.disabled = false;
qualitySelect.disabled = false;
socket.emit('watcher');

// ---------- Nome do usuário (pedido só na primeira vez, guardado no navegador) ----------

const NAME_STORAGE_KEY = 'screenshare_displayName';
const nomeSalvo = localStorage.getItem(NAME_STORAGE_KEY);

if (nomeSalvo) {
  socket.emit('identify', nomeSalvo);
} else {
  nameOverlay.classList.remove('hidden');
}

nameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const nome = nameInput.value.trim();
  if (!nome) return;
  localStorage.setItem(NAME_STORAGE_KEY, nome);
  socket.emit('identify', nome);
  nameOverlay.classList.add('hidden');
});

// ---------- Lista de quem está assistindo ----------

socket.on('viewers-list', (nomes) => {
  viewersCount.textContent = nomes.length;
  viewersList.innerHTML = nomes.length
    ? nomes.map((nome) => `<li>${escapeHtml(nome)}</li>`).join('')
    : '<li class="empty">Ninguém assistindo</li>';
});

viewersBtn.addEventListener('click', () => {
  viewersPanel.classList.toggle('hidden');
});

function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

// ---------- Quem compartilha a tela (broadcaster) ----------

shareBtn.addEventListener('click', async () => {
  try {
    const preset = QUALITY_PRESETS[qualitySelect.value] || QUALITY_PRESETS.medium;
    // systemAudio: 'include' pede ao Chrome pra já vir com "Compartilhar áudio" marcado;
    // só funciona ao escolher "Toda a tela" ou uma aba — janelas específicas não suportam áudio
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: { ideal: preset.width },
        height: { ideal: preset.height },
        frameRate: { ideal: preset.frameRate },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      systemAudio: 'include',
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
    statusEl.textContent = mensagemStatusAudio(localStream);
  } catch (err) {
    console.error('Erro ao capturar a tela:', err);
    statusEl.textContent = 'Não foi possível iniciar o compartilhamento.';
  }
});

stopBtn.addEventListener('click', stopSharing);

// O áudio de outros apps (fora do navegador) só é capturado pelo Chrome/Edge no Windows,
// e mesmo assim só ao escolher "Toda a tela" — é limitação do navegador/SO, não do código
function mensagemStatusAudio(stream) {
  if (stream.getAudioTracks().length) {
    return 'Você está compartilhando sua tela.';
  }
  const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  if (displaySurface === 'window') {
    return 'Você está compartilhando sua tela (sem áudio: compartilhar uma janela específica nunca captura som; escolha "Toda a tela" ou uma aba).';
  }
  return 'Você está compartilhando sua tela (sem áudio: seu navegador/sistema operacional não suporta capturar o som do computador aqui).';
}

function stopSharing() {
  if (!localStream) return;

  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  localVideo.srcObject = null;

  Object.values(peerConnections).forEach((pc) => pc.close());
  for (const id in peerConnections) {
    delete peerConnections[id];
    delete pendingCandidates[id];
  }

  // Avisa o servidor para repassar aos espectadores que a transmissão acabou
  socket.emit('stop-broadcast');

  shareBtn.disabled = false;
  stopBtn.disabled = true;
  qualitySelect.disabled = false;
  localBox.classList.add('hidden');
  statusEl.textContent = 'Compartilhamento encerrado.';
}

// Conta a tentativa de negociação mais recente por espectador; usado para descartar
// tentativas antigas que só terminam de "esperar" depois de uma mais nova já ter assumido
// (evita duas RTCPeerConnection enviando a mesma stream ao mesmo tempo para o mesmo peer)
const watcherNegotiationSeq = {};

socket.on('watcher', async (watcherId) => {
  if (!localStream) return;

  const minhaSeq = (watcherNegotiationSeq[watcherId] = (watcherNegotiationSeq[watcherId] || 0) + 1);

  // Se já existia uma conexão antiga pra esse espectador (ex.: reconexão rápida), fecha antes de recriar
  if (peerConnections[watcherId]) {
    peerConnections[watcherId].close();
    delete peerConnections[watcherId];
  }

  const rtcConfig = await rtcConfigPromise;

  // Uma tentativa mais nova pode ter chegado enquanto esperávamos os ICE servers; descarta esta
  if (watcherNegotiationSeq[watcherId] !== minhaSeq) return;

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections[watcherId] = pc;

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('candidate', watcherId, event.candidate);
    }
  };

  // Ajuda a diagnosticar espectadores que não conseguem conectar (ex.: falta de TURN);
  // restartIce() aqui não adiantaria, pois é o espectador quem vai pedir uma nova oferta
  pc.oniceconnectionstatechange = () => {
    console.log(`[broadcaster] ICE state com ${watcherId}: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === 'failed') {
      pc.close();
      delete peerConnections[watcherId];
      delete pendingCandidates[watcherId];
    }
  };

  pc.createOffer()
    .then((offer) => pc.setLocalDescription(offer))
    .then(() => socket.emit('offer', watcherId, pc.localDescription))
    .catch((err) => console.error('Erro ao criar oferta para', watcherId, err));
});

socket.on('answer', (watcherId, description) => {
  const pc = peerConnections[watcherId];
  if (!pc) return;
  pc.setRemoteDescription(description)
    .then(() => esvaziarCandidatesPendentes(watcherId, pc))
    .catch((err) => console.error('Erro ao aplicar answer de', watcherId, err));
});

socket.on('watcher-disconnected', (watcherId) => {
  const pc = peerConnections[watcherId];
  if (pc) {
    pc.close();
    delete peerConnections[watcherId];
  }
  delete pendingCandidates[watcherId];
});

// ---------- Quem assiste a tela (watcher) ----------

// Mesma lógica de descarte de tentativas antigas usada no lado do broadcaster
let ofertaSeq = 0;

socket.on('offer', async (broadcasterId, description) => {
  const minhaSeq = ++ofertaSeq;

  // Se já havía uma conexão anterior (ex.: nova transmissão começando), fecha antes de recriar
  if (watcherConnection) {
    watcherConnection.close();
    watcherConnection = null;
  }

  const rtcConfig = await rtcConfigPromise;

  // Uma oferta mais nova pode ter chegado enquanto esperávamos os ICE servers; descarta esta
  if (minhaSeq !== ofertaSeq) return;

  watcherConnection = new RTCPeerConnection(rtcConfig);

  watcherConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    remoteBox.classList.remove('hidden');
    localBox.classList.add('hidden');
    document.body.classList.add('watching');
    statusEl.textContent = 'Assistindo à tela compartilhada.';
    // Sempre exibe o controle de volume; áudio/vídeo podem chegar em eventos separados,
    // então não dá para confiar em getAudioTracks() no primeiro disparo do ontrack
    volumeControl.classList.remove('hidden');
    // Alguns navegadores (ex.: aba anônima) bloqueiam o autoplay; força o play manualmente
    remoteVideo.play().catch((err) => console.warn('Falha ao iniciar o vídeo automaticamente:', err));
  };

  watcherConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('candidate', broadcasterId, event.candidate);
    }
  };

  // Quem assiste nunca cria ofertas, então restartIce() aqui não teria efeito nenhum;
  // a forma que realmente funciona é fechar e pedir uma oferta nova do zero ao broadcaster
  watcherConnection.oniceconnectionstatechange = () => {
    console.log(`[watcher] ICE state: ${watcherConnection.iceConnectionState}`);
    if (watcherConnection.iceConnectionState === 'failed') {
      statusEl.textContent = 'Conexão falhou. Reconectando automaticamente...';
      watcherConnection.close();
      watcherConnection = null;
      socket.emit('watcher');
    }
  };

  watcherConnection
    .setRemoteDescription(description)
    .then(() => esvaziarCandidatesPendentes(broadcasterId, watcherConnection))
    .then(() => watcherConnection.createAnswer())
    .then((answer) => watcherConnection.setLocalDescription(answer))
    .then(() => socket.emit('answer', broadcasterId, watcherConnection.localDescription))
    .catch((err) => console.error('Erro ao responder oferta de', broadcasterId, err));
});

socket.on('candidate', (id, candidate) => {
  const pc = peerConnections[id] || watcherConnection;
  adicionarOuEnfileirarCandidate(id, pc, candidate);
});

socket.on('broadcaster', () => {
  socket.emit('watcher');
});

socket.on('broadcaster-disconnected', () => {
  if (watcherConnection) {
    watcherConnection.close();
    watcherConnection = null;
  }
  remoteVideo.srcObject = null;
  remoteBox.classList.add('hidden');
  volumeControl.classList.add('hidden');
  document.body.classList.remove('watching');
  statusEl.textContent = 'O compartilhamento de tela foi encerrado.';
});

volumeSlider.addEventListener('input', () => {
  const value = Number(volumeSlider.value);
  remoteVideo.muted = value === 0;
  remoteVideo.volume = value / 100;
  volumeIcon.textContent = value === 0 ? '🔇' : '🔊';
  remoteVideo.play().catch((err) => console.warn('Falha ao ativar o som:', err));
});

// Guarda o último volume não-zero para restaurar ao desmutar pelo ícone
let lastVolume = Number(volumeSlider.value) || 50;

volumeIcon.addEventListener('click', () => {
  if (remoteVideo.muted || Number(volumeSlider.value) === 0) {
    remoteVideo.muted = false;
    remoteVideo.volume = lastVolume / 100;
    volumeSlider.value = lastVolume;
    volumeIcon.textContent = '🔊';
    remoteVideo.play().catch((err) => console.warn('Falha ao ativar o som:', err));
  } else {
    lastVolume = Number(volumeSlider.value) || lastVolume;
    remoteVideo.muted = true;
    volumeSlider.value = 0;
    volumeIcon.textContent = '🔇';
  }
});

fullscreenBtn.addEventListener('click', () => {
  // Deixa só o <video> em tela cheia (não a caixa) para o navegador usar o caminho
  // acelerado por GPU do vídeo; fullscreen na caixa força composição por software e trava
  if (remoteVideo.requestFullscreen) {
    remoteVideo.requestFullscreen().catch((err) => console.warn('Falha ao entrar em tela cheia:', err));
  }
});

// Como o vídeo some da tela normal quando é ele o elemento em fullscreen, usamos os
// controles nativos do navegador (volume, sair da tela cheia) enquanto estiver nesse modo
document.addEventListener('fullscreenchange', () => {
  const emTelaCheia = document.fullscreenElement === remoteVideo;
  remoteVideo.controls = emTelaCheia;
  if (!emTelaCheia) {
    // Sincroniza o slider com o volume/mudo que o usuário pode ter ajustado nos controles nativos
    volumeSlider.value = Math.round(remoteVideo.muted ? 0 : remoteVideo.volume * 100);
    volumeIcon.textContent = remoteVideo.muted || remoteVideo.volume === 0 ? '🔇' : '🔊';
  }
});

drawerToggle.addEventListener('click', () => {
  remoteControls.classList.toggle('open');
});
