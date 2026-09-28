const socket = io();
const el = id => document.getElementById(id);

let CUR = '€';
let latest = null;      // most recent state pushed by the server
let clockOffset = 0;    // server clock minus this device's clock, so the timer is right on any device

fetch('/api/auction/config').then(r => r.json()).then(c => { CUR = c.currency || CUR; if (latest) render(latest); }).catch(() => {});

const panels = ['idleState', 'breakState', 'finishedState', 'playerStage'];
function showPanel(id) { panels.forEach(p => el(p).classList.toggle('hidden', p !== id)); }

function money(n) { return n == null ? '—' : `${CUR}${Number(n).toLocaleString('en-GB')}M`; }

// photo_path is "assets/avatars/x.svg" (served from /public) or "uploads/players/x.jpg"
function resolvePhotoUrl(photoPath) {
  if (!photoPath) return '/public/assets/avatars/male1.svg';
  if (photoPath.startsWith('assets/')) return '/public/' + photoPath;
  return '/' + photoPath.replace(/\\/g, '/');
}

let lastPlayerId = null;
let lastBidAmount = null;

function renderTeams(teams, leadingTeamId) {
  el('teamsStrip').innerHTML = teams.map(t => `
    <div class="team-chip${t.id === leadingTeamId ? ' leading' : ''}">
      <div class="t-name">${t.name}</div>
      <div class="t-purse">Purse: ${money(t.purse_remaining)}</div>
      <div class="t-count">${t.players_count} players</div>
    </div>`).join('');
}

function launchConfetti() {
  const colors = ['#4ade80', '#38bdf8', '#facc15', '#f87171', '#a78bfa'];
  for (let i = 0; i < 60; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.left = Math.random() * 100 + 'vw';
    piece.style.background = colors[Math.floor(Math.random() * colors.length)];
    piece.style.animationDuration = (2 + Math.random() * 1.5) + 's';
    document.body.appendChild(piece);
    setTimeout(() => piece.remove(), 4000);
  }
}

function flashOverlay(id, ms = 2200) {
  el(id).classList.remove('hidden');
  setTimeout(() => el(id).classList.add('hidden'), ms);
}

function render(data) {
  latest = data;
  clockOffset = data.server_time - Date.now();
  const { state, currentPlayer, teams } = data;

  el('roundBadge').textContent = state.round === 2 ? 'ROUND 2 — UNSOLD PLAYERS' : 'ROUND 1';
  el('progressCounter').textContent = `${state.players_auctioned_count} auctioned`;

  if (state.status === 'break') { showPanel('breakState'); return; }
  if (state.status === 'finished') { showPanel('finishedState'); return; }
  if (!currentPlayer) { showPanel('idleState'); return; }

  showPanel('playerStage');

  if (currentPlayer.id !== lastPlayerId) {
    lastPlayerId = currentPlayer.id;
    lastBidAmount = null;
    el('playerPhoto').src = resolvePhotoUrl(currentPlayer.photo_path);
    el('playerName').textContent = currentPlayer.full_name;
    el('playerCategory').textContent = currentPlayer.category.toUpperCase();
    el('playerPositions').textContent = 'Positions: ' + (currentPlayer.preferred_positions || '—');
    el('playerClub').textContent = 'Favourite Club: ' + (currentPlayer.favourite_club || '—');
    el('playerExperience').textContent = currentPlayer.experience ? ('Experience: ' + currentPlayer.experience) : '';
    el('basePrice').textContent = money(currentPlayer.base_price);
  }

  const bidTeam = teams.find(t => t.id === state.current_bid_team_id);
  el('currentBid').textContent = money(state.current_bid || currentPlayer.base_price);
  el('currentTeam').textContent = bidTeam ? bidTeam.name : 'No bids yet';

  if (state.current_bid && state.current_bid !== lastBidAmount) {
    lastBidAmount = state.current_bid;
    const block = el('currentBidBlock');
    block.classList.add('bump');
    setTimeout(() => block.classList.remove('bump'), 260);
  }
  renderTeams(teams, state.current_bid_team_id);
}

// ---- The countdown: redrawn every animation frame from timer_ends_at ----
// Reaching zero does NOT mark the player unsold - the ring just turns red and
// waits for the admin to press Sold or Unsold.
const RING_LENGTH = 327;
function tick() {
  requestAnimationFrame(tick);
  if (!latest) return;
  const { state } = latest;

  if (state.status === 'break') {
    const rem = Math.max(0, (state.timer_ends_at || 0) - (Date.now() + clockOffset));
    const secs = Math.ceil(rem / 1000);
    el('breakTimer').textContent = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
    return;
  }
  if (!state.current_player_id) return;

  const total = state.timer_total_ms || 20000;
  const paused = state.status === 'paused';
  let remaining = total;
  if (paused) remaining = state.timer_remaining_ms || 0;
  else if (state.timer_ends_at) remaining = Math.max(0, state.timer_ends_at - (Date.now() + clockOffset));

  const fraction = Math.min(1, remaining / total);
  const ring = el('ringFg');
  ring.style.strokeDashoffset = RING_LENGTH * (1 - fraction);
  ring.style.stroke = remaining <= 3000 ? '#f87171' : remaining <= 5000 ? '#fb923c' : '#38bdf8';

  const timeUp = !paused && remaining <= 0;
  el('timerNum').textContent = Math.ceil(remaining / 1000);
  el('timerWrap').classList.toggle('paused', paused);
  el('timerWrap').classList.toggle('time-up', timeUp);
  el('timerLabel').textContent = paused ? 'PAUSED' : timeUp ? 'TIME UP' : '\u00a0';
}
requestAnimationFrame(tick);

socket.on('state-update', render);
socket.on('player-sold-event', ({ teamName, amount }) => {
  el('soldTeamName').textContent = teamName;
  el('soldAmount').textContent = money(amount);
  flashOverlay('soldOverlay');
  launchConfetti();
});
socket.on('player-unsold-event', () => flashOverlay('unsoldOverlay'));
