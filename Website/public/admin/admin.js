const socket = io();
const el = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let CUR = '€';
let TEAMS = [];   // cached so tables can show team names instead of ids

fetch('/api/auction/config').then(r => r.json()).then(c => { CUR = c.currency || CUR; }).catch(() => {});
const money = n => (n == null ? '—' : `${CUR}${Number(n).toLocaleString('en-GB')}M`);
const byName = (a, b) => a.full_name.localeCompare(b.full_name);
const teamName = id => (id ? ((TEAMS.find(t => t.id === id) || {}).name || `Team #${id}`) : '—');
const photoUrl = path => (!path ? '/public/assets/avatars/male1.svg'
  : path.startsWith('assets/') ? '/public/' + path : '/' + path.replace(/\\/g, '/'));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ---------- Auth ----------
fetch('/api/admin/check').then(r => r.json()).then(({ isAdmin }) => { if (!isAdmin) window.location.href = '/admin/login.html'; });
el('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' });
  window.location.href = '/admin/login.html';
});

// ---------- Tabs ----------
const LOADERS = { teams: () => loadTeams(), females: () => loadFemales(), players: () => loadPlayers(), unsold: () => loadUnsold(), transfers: () => loadTransfers(), teamview: () => loadTeamRosters() };
document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn[data-tab]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    el('tab-' + btn.dataset.tab).classList.add('active');
    if (LOADERS[btn.dataset.tab]) LOADERS[btn.dataset.tab]();
  });
});

// ---------- Shared drop-down builders ----------
function teamOptionsHtml(selectedId) {
  return '<option value="">— Unassigned —</option>' +
    TEAMS.map(t => `<option value="${t.id}" ${t.id === selectedId ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

// Captain choices: predecided players first, then every other male who is still free.
function captainOptionsHtml(males, team) {
  const selected = team ? team.captain_player_id : null;
  const eligible = males.filter(p => p.is_captain
    ? (team && p.sold_team_id === team.id)
    : ['pending', 'reserved', 'assigned'].includes(p.status));
  const opt = p => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.full_name)}</option>`;
  const pre = eligible.filter(p => p.predecided).sort(byName);
  const rest = eligible.filter(p => !p.predecided).sort(byName);
  return '<option value="">— Select captain —</option>' +
    (pre.length ? `<optgroup label="Predecided players">${pre.map(opt).join('')}</optgroup>` : '') +
    (rest.length ? `<optgroup label="Other male players">${rest.map(opt).join('')}</optgroup>` : '');
}

async function handleAssignChange(e, reload) {
  const sel = e.target;
  if (!sel.classList.contains('assign-select')) return;
  try {
    if (sel.value) await api(`/api/admin/players/${sel.dataset.player}/assign`, { method: 'POST', body: JSON.stringify({ team_id: Number(sel.value) }) });
    else await api(`/api/admin/players/${sel.dataset.player}/unassign`, { method: 'POST' });
  } catch (err) { alert(err.message); }
  reload();
}

// ---------- TEAMS & CAPTAINS ----------
async function loadTeams() {
  const [teams, players] = await Promise.all([api('/api/admin/teams'), api('/api/admin/players')]);
  TEAMS = teams;
  const males = players.filter(p => p.gender !== 'Female');

  el('teamCaptain').innerHTML = captainOptionsHtml(males, null);
  el('teamsTable').querySelector('tbody').innerHTML = teams.length ? teams.map(t => `
    <tr>
      <td>${esc(t.name)}</td>
      <td><select class="captain-select" data-team="${t.id}">${captainOptionsHtml(males, t)}</select></td>
      <td>${money(t.purse_remaining)}</td>
      <td>${t.players_count}</td>
      <td>${t.female_count}</td>
      <td><button data-del="${t.id}">Delete</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="hint">No teams yet.</td></tr>';

  const left = males.filter(p => p.predecided && !p.is_captain).sort(byName);
  el('predecidedTable').querySelector('tbody').innerHTML = left.length ? left.map(p => `
    <tr>
      <td>${esc(p.full_name)}</td><td>${esc(p.category)}</td>
      <td><select class="assign-select" data-player="${p.id}">${teamOptionsHtml(p.sold_team_id)}</select></td>
    </tr>`).join('') : '<tr><td colspan="3" class="hint">No predecided players waiting for a team.</td></tr>';
}

el('teamForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/teams', { method: 'POST', body: JSON.stringify({
      name: el('teamName').value, captain_player_id: el('teamCaptain').value ? Number(el('teamCaptain').value) : null
    }) });
    e.target.reset();
  } catch (err) { alert(err.message); }
  loadTeams();
});
el('teamsTable').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('captain-select')) return;
  try {
    await api(`/api/admin/teams/${e.target.dataset.team}/captain`, { method: 'PUT',
      body: JSON.stringify({ player_id: e.target.value ? Number(e.target.value) : null }) });
  } catch (err) { alert(err.message); }
  loadTeams();
});
el('teamsTable').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id || !confirm('Delete this team? Its captain and pre-assigned players go back to unassigned.')) return;
  try { await api('/api/admin/teams/' + id, { method: 'DELETE' }); } catch (err) { alert(err.message); }
  loadTeams();
});
el('predecidedTable').addEventListener('change', e => handleAssignChange(e, loadTeams));

// ---------- FEMALE PLAYERS ----------
async function loadFemales() {
  const [teams, players] = await Promise.all([api('/api/admin/teams'), api('/api/admin/players')]);
  TEAMS = teams;
  const females = players.filter(p => p.gender === 'Female').sort(byName);
  const assigned = females.filter(p => p.sold_team_id).length;
  el('femaleSummary').textContent = females.length
    ? `${assigned} of ${females.length} female players assigned.`
    : 'No female players yet — import a sheet that has a "Females" tab.';
  el('femalesTable').querySelector('tbody').innerHTML = females.map(p => `
    <tr>
      <td><img src="${photoUrl(p.photo_path)}"></td>
      <td>${esc(p.full_name)}</td>
      <td>${esc(p.preferred_positions || '—')}</td>
      <td><select class="assign-select" data-player="${p.id}">${teamOptionsHtml(p.sold_team_id)}</select></td>
    </tr>`).join('');
}
el('femalesTable').addEventListener('change', e => handleAssignChange(e, loadFemales));

// ---------- ALL PLAYERS ----------
let allPlayers = [];
const FILTERS = {
  all: () => true,
  pool: p => p.gender !== 'Female' && !p.predecided && !p.is_captain,
  predecided: p => p.predecided,
  captains: p => p.is_captain,
  females: p => p.gender === 'Female',
  sold: p => p.status === 'sold' || p.status === 'allocated'
};
async function loadPlayers() {
  [allPlayers, TEAMS] = await Promise.all([api('/api/admin/players'), api('/api/admin/teams')]);
  renderPlayers();
}
function renderPlayers() {
  const q = el('playerSearch').value.toLowerCase();
  const filter = FILTERS[el('playerFilter').value] || FILTERS.all;
  const rows = allPlayers.filter(p => filter(p) && p.full_name.toLowerCase().includes(q));
  el('playersTable').querySelector('tbody').innerHTML = rows.map(p => `
    <tr>
      <td><img src="${photoUrl(p.photo_path)}"></td>
      <td>${esc(p.full_name)}${p.is_captain ? ' <em>(captain)</em>' : p.predecided ? ' <em>(predecided)</em>' : p.is_fixed ? ' <em>(fixed)</em>' : ''}</td>
      <td>${p.gender || 'Male'}</td>
      <td>${p.category}</td>
      <td>${money(p.base_price)}</td>
      <td>${p.status}</td>
      <td>${teamName(p.sold_team_id)}</td>
      <td>${p.sold_price ? money(p.sold_price) : '—'}</td>
      <td><button data-del="${p.id}">Delete</button></td>
    </tr>`).join('');
}
el('playerSearch').addEventListener('input', renderPlayers);
el('playerFilter').addEventListener('change', renderPlayers);
el('playersTable').addEventListener('click', async (e) => {
  const id = e.target.dataset.del;
  if (!id || !confirm('Delete this player?')) return;
  await api('/api/admin/players/' + id, { method: 'DELETE' });
  loadPlayers();
});
el('fixedPlayerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/admin/players/fixed', { method: 'POST', body: JSON.stringify({
    full_name: el('fpName').value, category: el('fpCategory').value,
    preferred_positions: el('fpPositions').value, favourite_club: el('fpClub').value
  }) });
  e.target.reset();
  loadPlayers();
});

// ---------- IMPORT ----------
function showImportResult(data) {
  el('importResult').innerHTML =
    `Imported <strong>${data.inserted}</strong> new players (${data.males} male, ${data.females} female; ${data.predecided} predecided). ` +
    `Skipped ${data.skipped} already in the database.` +
    ((data.warnings || []).length ? `<br><span class="error">${data.warnings.map(esc).join('<br>')}</span>` : '');
}
el('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = el('sheetFile').files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('sheet', file);
  const res = await fetch('/api/admin/players/import-upload', { method: 'POST', body: fd });
  const data = await res.json();
  if (res.ok) showImportResult(data); else el('importResult').innerHTML = `<span class="error">Error: ${esc(data.error)}</span>`;
});
el('pathForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { showImportResult(await api('/api/admin/players/import-from-path', { method: 'POST', body: JSON.stringify({ filePath: el('sheetPath').value }) })); }
  catch (err) { el('importResult').innerHTML = `<span class="error">Error: ${esc(err.message)}</span>`; }
});
el('bulkPhotoForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const files = el('bulkPhotoFiles').files;
  if (!files.length) return;
  const fd = new FormData();
  for (const f of files) fd.append('photos', f);
  const res = await fetch('/api/admin/players/photos/bulk-upload', { method: 'POST', body: fd });
  const data = await res.json();
  const box = el('bulkPhotoResult');
  if (!res.ok) { box.innerHTML = `<p class="error">Error: ${esc(data.error)}</p>`; return; }
  box.innerHTML = `
    <p><strong>${data.matched.length}</strong> matched and assigned.</p>
    ${data.matched.length ? '<ul>' + data.matched.map(m => `<li>${esc(m.file)} → ${esc(m.player)}</li>`).join('') + '</ul>' : ''}
    ${data.unmatched.length ? `<p class="error">${data.unmatched.length} file(s) matched no player: ${data.unmatched.map(esc).join(', ')}</p>` : ''}
    ${data.ambiguous.length ? `<p class="error">${data.ambiguous.length} file(s) matched more than one player: ${data.ambiguous.map(a => `${esc(a.file)} → [${a.candidates.map(esc).join(' / ')}]`).join('; ')}</p>` : ''}`;
});

// ---------- UNSOLD POOL ----------
async function loadUnsold() {
  const [players, teams] = await Promise.all([api('/api/admin/unsold'), api('/api/admin/teams')]);
  TEAMS = teams;
  const container = el('unsoldList');
  container.innerHTML = '';
  for (const p of players) {
    const requests = await api(`/api/admin/unsold/${p.id}/requests`);
    const card = document.createElement('div');
    card.className = 'unsold-card';
    card.innerHTML = `
      <div><strong>${esc(p.full_name)}</strong> (${esc(p.category)}, base ${money(p.base_price)})</div>
      <div class="req-list">Requested by: ${requests.map(r => esc(r.team_name)).join(', ') || 'none yet'}</div>
      <select class="req-team-select">${teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>
      <button class="req-btn">Add Request</button>
      <button class="alloc-btn" ${requests.length === 0 ? 'disabled' : ''}>Allocate ${requests.length > 1 ? '(Random)' : ''}</button>`;
    card.querySelector('.req-btn').addEventListener('click', async () => {
      await api('/api/admin/unsold/request', { method: 'POST', body: JSON.stringify({ player_id: p.id, team_id: Number(card.querySelector('.req-team-select').value) }) });
      loadUnsold();
    });
    card.querySelector('.alloc-btn').addEventListener('click', async () => {
      const result = await api(`/api/admin/unsold/${p.id}/allocate`, { method: 'POST' });
      alert(`${p.full_name} allocated to ${teamName(result.winnerTeamId)} (from ${result.candidates.length} request${result.candidates.length > 1 ? 's' : ''}).`);
      loadUnsold();
    });
    container.appendChild(card);
  }
  if (players.length === 0) container.innerHTML = '<p class="hint">No unsold players remaining.</p>';
}

// ---------- TRANSFERS ----------
async function loadTransfers() {
  const [players, teams, transfers] = await Promise.all([api('/api/admin/players'), api('/api/admin/teams'), api('/api/admin/transfers')]);
  TEAMS = teams;
  const movable = players.filter(p => (p.status === 'sold' || p.status === 'allocated') && !p.is_captain);
  el('trPlayer').innerHTML = movable.map(p => `<option value="${p.id}">${esc(p.full_name)} (currently: ${esc(teamName(p.sold_team_id))})</option>`).join('');
  el('trToTeam').innerHTML = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  el('transfersTable').querySelector('tbody').innerHTML = transfers.map(t => `
    <tr><td>${esc(t.full_name)}</td><td>${esc(t.from_team || '—')}</td><td>${esc(t.to_team || '—')}</td><td>${t.transfer_type}</td><td>${new Date(t.reported_at).toLocaleString()}</td></tr>`).join('');
}
el('transferForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/admin/transfers', { method: 'POST', body: JSON.stringify({
      player_id: el('trPlayer').value, to_team_id: el('trToTeam').value, transfer_type: 'swap', notes: el('trNotes').value }) });
    loadTransfers();
  } catch (err) { alert(err.message); }
});

// ---------- LIVE AUCTION CONTROL ----------
function showLiveError(msg) {
  el('liveError').textContent = msg;
  el('liveError').classList.remove('hidden');
  setTimeout(() => el('liveError').classList.add('hidden'), 4000);
}
const post = (path, body) => async () => {
  try { await api(path, { method: 'POST', body: body ? JSON.stringify(body()) : undefined }); }
  catch (err) { showLiveError(err.message); }
};
el('startBtn').addEventListener('click', post('/api/auction/start', () => ({ round: Number(el('roundSelect').value) })));
el('pauseBtn').addEventListener('click', post('/api/auction/pause'));
el('resumeBtn').addEventListener('click', post('/api/auction/resume'));
el('resumeBreakBtn').addEventListener('click', post('/api/auction/resume-from-break'));
el('soldBtn').addEventListener('click', post('/api/auction/sold'));
el('unsoldBtn').addEventListener('click', post('/api/auction/unsold'));
window.placeBid = teamId => post('/api/auction/bid', () => ({ teamId }))();

function nextBidPreview(current) {
  const step = current < 50 ? 5 : (current <= 200 ? 10 : 20);
  return Math.ceil((current + step) / 5) * 5;
}

let liveData = null;
let clockOffset = 0;

function renderLiveState(data) {
  liveData = data;
  clockOffset = data.server_time - Date.now();
  const { state, currentPlayer, teams } = data;
  TEAMS = teams;
  const leader = teams.find(t => t.id === state.current_bid_team_id);

  el('liveCurrentPlayer').innerHTML = currentPlayer ? `
    <h3>${esc(currentPlayer.full_name)} <small>(${esc(currentPlayer.category)}, base ${money(currentPlayer.base_price)})</small></h3>
    <p>Current bid: <strong>${money(state.current_bid || currentPlayer.base_price)}</strong>
       ${leader ? 'by <strong>' + esc(leader.name) + '</strong>' : '(no bids yet)'}</p>
    <p>Status: ${state.status} · Round ${state.round} · Auctioned so far: ${state.players_auctioned_count}</p>`
    : `<p>No active player. Status: ${state.status}</p>`;

  // Hide the Unsold button if there is a current bid
  if (state.current_bid_team_id) {
    el('unsoldBtn').classList.add('hidden');
  } else {
    el('unsoldBtn').classList.remove('hidden');
  }

  el('liveTeamButtons').innerHTML = teams.map(t => {
    const current = currentPlayer ? (state.current_bid || currentPlayer.base_price) : 0;
    const next = nextBidPreview(current);
    const disabled = state.status !== 'running' || !currentPlayer || t.purse_remaining < next
      || t.id === state.current_bid_team_id || t.auction_count >= 16;
    return `
      <button class="team-bid-btn" ${disabled ? 'disabled' : ''} onclick="placeBid(${t.id})">
        <div class="tb-name">${esc(t.name)}</div>
        <div class="tb-purse">Purse: ${money(t.purse_remaining)} · Squad ${t.players_count} (${t.auction_count} bought)</div>
        <div class="tb-next">Bid ${money(next)}</div>
      </button>`;
  }).join('');
  updateLiveTimer();
}

// Local countdown so the admin can see the same clock as the room.
function updateLiveTimer() {
  const box = el('liveTimer');
  if (!liveData) return;
  const { state } = liveData;
  const now = Date.now() + clockOffset;
  box.className = 'live-timer';
  if (state.status === 'paused') {
    box.classList.add('paused');
    box.textContent = `⏸ Paused — ${Math.ceil((state.timer_remaining_ms || 0) / 1000)}s left`;
  } else if (state.status === 'running' && state.timer_ends_at) {
    const rem = state.timer_ends_at - now;
    if (rem > 0) box.textContent = `⏱ ${Math.ceil(rem / 1000)}s`;
    else { box.classList.add('time-up'); box.textContent = '⏱ TIME UP — choose Sold or Unsold'; }
  } else if (state.status === 'break') {
    const secs = Math.max(0, Math.ceil((state.timer_ends_at - now) / 1000));
    box.textContent = `☕ Break — ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · press "Resume From Break"`;
  } else if (state.status === 'finished') {
    box.textContent = '🏁 Round finished';
  } else {
    box.textContent = '';
  }
}
setInterval(updateLiveTimer, 200);

socket.on('state-update', renderLiveState);

loadTeams();

// ---------- TEAM ROSTERS VIEW ----------
async function loadTeamRosters() {
  const [teams, players] = await Promise.all([api('/api/admin/teams'), api('/api/admin/players')]);
  const container = el('teamRostersContainer');
  
  if (!teams.length) {
    container.innerHTML = '<p class="hint">No teams created yet.</p>';
    return;
  }

  let html = '';
  teams.forEach(t => {
    // Get players belonging to this team
    const squad = players.filter(p => p.sold_team_id === t.id);
    
    // Sort logic: Captains first, then predecided/females, then auction buys by price/name
    squad.sort((a, b) => (b.is_captain ? 1 : 0) - (a.is_captain ? 1 : 0) || a.full_name.localeCompare(b.full_name));

    html += `<h2>${esc(t.name)} <small style="font-size: 14px; opacity: 0.8; font-weight: normal; margin-left: 10px;">(Purse Remaining: ${money(t.purse_remaining)})</small></h2>`;
    html += `<table class="data-table" style="margin-bottom: 30px;">
      <thead>
        <tr>
          <th style="width: 60px;">Photo</th>
          <th>Name</th>
          <th>Role / Category</th>
          <th>Acquisition Price</th>
        </tr>
      </thead>
      <tbody>`;
    
    if (!squad.length) {
      html += `<tr><td colspan="4" class="hint" style="text-align: center;">No players assigned to this team yet.</td></tr>`;
    } else {
      html += squad.map(p => `
        <tr>
          <td><img src="${photoUrl(p.photo_path)}" style="width: 40px; height: 40px; border-radius: 50%; object-fit: cover;"></td>
          <td><strong>${esc(p.full_name)}</strong></td>
          <td>${p.is_captain ? '<span style="color: #facc15; font-weight: bold;">Captain</span>' : p.gender === 'Female' ? 'Female Player' : p.predecided ? 'Predecided' : esc(p.category)}</td>
          <td>${p.sold_price ? money(p.sold_price) : '—'}</td>
        </tr>
      `).join('');
    }
    html += `</tbody></table>`;
  });
  
  container.innerHTML = html;
}