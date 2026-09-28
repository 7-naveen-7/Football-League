// A tiny JSON-file "database". Each collection is one human-editable file
// under /data. All reads/writes are SYNCHRONOUS on purpose: Node won't
// interleave other requests in the middle of a sync read-modify-write, so
// this is safe against concurrent bids without any locking library.
// Edit these files by hand only while the auction is paused / server stopped.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function filePath(name) { return path.join(DATA_DIR, `${name}.json`); }
function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function readJSON(name, fallback) {
  ensureDataDir();
  const fp = filePath(name);
  if (!fs.existsSync(fp)) {
    writeJSON(name, fallback);
    return JSON.parse(JSON.stringify(fallback));
  }
  const raw = fs.readFileSync(fp, 'utf8').trim();
  return raw ? JSON.parse(raw) : fallback;
}

// Write to a temp file then rename, so a crash mid-write can't leave corrupt JSON.
function writeJSON(name, data) {
  ensureDataDir();
  const fp = filePath(name);
  // Write the data directly to the final file, skipping the temp step
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function nextId(records) { return records.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1; }
function nowISO() { return new Date().toISOString(); }

// ---------------- Teams ----------------
const teams = {
  all() { return readJSON('teams', []); },
  get(id) { return teams.all().find(t => t.id === Number(id)) || null; },
  // players_count  = male squad (captain + pre-assigned + auction buys); females are NOT included
  // female_count   = females assigned to the team (admin-only information)
  // auction_count  = players won through the auction rounds (used for the 16-player cap)
  withCounts() {
    const allPlayers = players.all();
    return teams.all().map(t => {
      const squad = allPlayers.filter(p => p.sold_team_id === t.id);
      return {
        ...t,
        players_count: squad.filter(p => p.gender !== 'Female').length,
        female_count: squad.filter(p => p.gender === 'Female').length,
        auction_count: squad.filter(p => p.round_sold === 1 || p.round_sold === 2).length
      };
    });
  },
  create({ name, purse_total }) {
    const list = teams.all();
    const record = {
      id: nextId(list), name,
      captain_player_id: null, captain_name: null,
      purse_total, purse_remaining: purse_total,
      logo_path: null, created_at: nowISO()
    };
    list.push(record);
    writeJSON('teams', list);
    return record;
  },
  update(id, fields) {
    const list = teams.all();
    const idx = list.findIndex(t => t.id === Number(id));
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...fields };
    writeJSON('teams', list);
    return list[idx];
  },
  adjustPurse(id, delta) {
    const t = teams.get(id);
    if (t) teams.update(id, { purse_remaining: t.purse_remaining + delta });
  },
  remove(id) { writeJSON('teams', teams.all().filter(t => t.id !== Number(id))); }
};

// ---------------- Players ----------------
// status values:
//   pending         in the Round 1 auction pool
//   in_auction      currently on the block
//   sold            won in Round 1/2
//   round2_pending  unsold in Round 1, waiting for Round 2
//   unsold          unsold after Round 2 (goes to the request/lottery pool)
//   allocated       given to a team from the unsold pool
//   reserved        NOT auctioned: predecided males + all females, waiting to be assigned
//   assigned        captain / predecided / female placed in a team by the admin (costs nothing)
const players = {
  all() { return readJSON('players', []); },
  get(id) { return players.all().find(p => p.id === Number(id)) || null; },
  findDuplicate(full_name, roll_number, email) {
    const list = players.all();
    if (!roll_number && !email) return list.find(p => p.full_name === full_name);
    return list.find(p =>
      p.full_name === full_name &&
      ((roll_number && p.roll_number === roll_number) || (email && p.email === email))
    );
  },
  create(data) {
    const list = players.all();
    const record = {
      id: nextId(list),
      full_name: data.full_name,
      roll_number: data.roll_number || '',
      email: data.email || '',
      gender: data.gender || 'Male',
      category: data.category,
      experience: data.experience || '',
      preferred_positions: data.preferred_positions || '',
      favourite_club: data.favourite_club || '',
      photo_path: data.photo_path || null,
      base_price: data.base_price,
      is_fixed: !!data.is_fixed,
      predecided: !!data.predecided,
      is_captain: !!data.is_captain,
      assign_type: data.assign_type || null,   // 'captain' | 'predecided' | 'female'
      status: data.status || 'pending',
      sold_team_id: data.sold_team_id || null,
      sold_price: data.sold_price || null,
      round_sold: data.round_sold != null ? data.round_sold : null,
      auction_order: data.auction_order != null ? data.auction_order : null,
      created_at: nowISO()
    };
    list.push(record);
    writeJSON('players', list);
    return record;
  },
  update(id, fields) {
    const list = players.all();
    const idx = list.findIndex(p => p.id === Number(id));
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...fields };
    writeJSON('players', list);
    return list[idx];
  },
  remove(id) { writeJSON('players', players.all().filter(p => p.id !== Number(id))); },
  byStatus(status) { return players.all().filter(p => p.status === status); },
  nextInQueue(status) {
    const list = players.byStatus(status).filter(p => p.auction_order != null);
    list.sort((a, b) => a.auction_order - b.auction_order);
    return list[0] || null;
  }
};

// ---------------- Auction state (singleton) ----------------
const DEFAULT_STATE = {
  round: 1, status: 'idle', current_player_id: null, current_bid: null,
  current_bid_team_id: null, timer_ends_at: null, timer_total_ms: null,
  timer_remaining_ms: null, players_auctioned_count: 0
};
const state = {
  get() { return { ...DEFAULT_STATE, ...readJSON('auction_state', DEFAULT_STATE) }; },
  update(fields) {
    const merged = { ...state.get(), ...fields };
    writeJSON('auction_state', merged);
    return merged;
  }
};

// ---------------- Bids (audit log) ----------------
const bids = {
  all() { return readJSON('bids', []); },
  add({ player_id, team_id, amount, round }) {
    const list = bids.all();
    list.push({ id: nextId(list), player_id, team_id, amount, round, created_at: nowISO() });
    writeJSON('bids', list);
  }
};

// ---------------- Transfers ----------------
const transfers = {
  all() { return readJSON('transfers', []); },
  add({ player_id, from_team_id, to_team_id, transfer_type, notes }) {
    const list = transfers.all();
    const record = {
      id: nextId(list), player_id: Number(player_id),
      from_team_id: from_team_id ? Number(from_team_id) : null,
      to_team_id: to_team_id ? Number(to_team_id) : null,
      transfer_type: transfer_type || 'manual', notes: notes || '', reported_at: nowISO()
    };
    list.push(record);
    writeJSON('transfers', list);
    return record;
  }
};

// ---------------- Unsold requests ----------------
const unsoldRequests = {
  all() { return readJSON('unsold_requests', []); },
  forPlayer(playerId) { return unsoldRequests.all().filter(r => r.player_id === Number(playerId)); },
  add({ player_id, team_id }) {
    const list = unsoldRequests.all();
    list.push({ id: nextId(list), player_id: Number(player_id), team_id: Number(team_id), created_at: nowISO() });
    writeJSON('unsold_requests', list);
  },
  clearForPlayer(playerId) {
    writeJSON('unsold_requests', unsoldRequests.all().filter(r => r.player_id !== Number(playerId)));
  }
};

module.exports = { teams, players, state, bids, transfers, unsoldRequests, DATA_DIR };
