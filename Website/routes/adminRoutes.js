const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const store = require('../db/dataStore');
const squad = require('../services/squadService');
const { requireAdmin } = require('../middleware/auth');
const { parsePlayerSheet, sanitizeFileName } = require('../services/excelImportService');
const { RULES } = require('../services/biddingRules');

const router = express.Router();
const upload = multer({ dest: path.join(__dirname, '..', 'uploads', 'tmp') });

// Keeps each file's original name available to the bulk photo matcher.
const bulkPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads', 'tmp')),
    filename: (req, file, cb) => cb(null, Date.now() + '__' + file.originalname)
  })
});

const fail = (res, err, code = 400) => res.status(code).json({ error: err.message });

// --- Auth ---
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});
router.post('/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
router.get('/check', (req, res) => res.json({ isAdmin: !!(req.session && req.session.isAdmin) }));

// --- Teams (purse is always the fixed total; captains are picked from the players list) ---
router.get('/teams', requireAdmin, (req, res) => res.json(store.teams.withCounts()));

router.post('/teams', requireAdmin, (req, res) => {
  try {
    const { name, captain_player_id } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Team name is required.' });
    const team = store.teams.create({ name: name.trim(), purse_total: RULES.TOTAL_PURSE });
    if (captain_player_id) {
      try { squad.setCaptain(team.id, captain_player_id); }
      catch (err) { store.teams.remove(team.id); throw err; }
    }
    res.json({ id: team.id });
  } catch (err) { fail(res, err); }
});

router.put('/teams/:id/captain', requireAdmin, (req, res) => {
  try { squad.setCaptain(req.params.id, req.body.player_id); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});

router.put('/teams/:id', requireAdmin, (req, res) => {
  if (req.body.name) store.teams.update(req.params.id, { name: req.body.name });
  res.json({ ok: true });
});

router.delete('/teams/:id', requireAdmin, (req, res) => {
  try {
    squad.releaseTeamPlayers(req.params.id);
    store.teams.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// --- Players ---
router.get('/players', requireAdmin, (req, res) => {
  const list = [...store.players.all()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.full_name.localeCompare(b.full_name));
  res.json(list);
});

function importPlayers(players, warnings) {
  const result = { inserted: 0, skipped: 0, total: players.length, males: 0, females: 0, predecided: 0, warnings: warnings || [] };
  for (const p of players) {
    if (store.players.findDuplicate(p.full_name, p.roll_number, p.email)) { result.skipped++; continue; }
    store.players.create(p);
    result.inserted++;
    if (p.gender === 'Female') result.females++; else result.males++;
    if (p.predecided) result.predecided++;
  }
  return result;
}

router.post('/players/import-from-path', requireAdmin, async (req, res) => {
  try {
    if (!req.body.filePath) return res.status(400).json({ error: 'filePath is required' });
    const { players, warnings } = await parsePlayerSheet(req.body.filePath);
    res.json(importPlayers(players, warnings));
  } catch (err) { console.error(err); fail(res, err, 500); }
});

router.post('/players/import-upload', requireAdmin, upload.single('sheet'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file received.' });
  try {
    const { players, warnings } = await parsePlayerSheet(req.file.path);
    res.json(importPlayers(players, warnings));
  } catch (err) { console.error(err); fail(res, err, 500); }
  finally { fs.unlink(req.file.path, () => {}); }
});

// A "fixed" male player who is not in the sheet at all
router.post('/players/fixed', requireAdmin, (req, res) => {
  const { full_name, category, preferred_positions, favourite_club, photo_path, sold_team_id, sold_price } = req.body;
  const base_price = RULES.BASE_PRICE[category] || RULES.BASE_PRICE.Beginner;
  const record = store.players.create({
    full_name, category, preferred_positions, favourite_club, photo_path,
    gender: 'Male', base_price, is_fixed: true,
    status: sold_team_id ? 'sold' : 'pending',
    sold_team_id: sold_team_id ? Number(sold_team_id) : null,
    sold_price: sold_price || null, round_sold: sold_team_id ? 0 : null
  });
  if (sold_team_id && sold_price) store.teams.adjustPurse(sold_team_id, -sold_price);
  res.json({ id: record.id });
});

// Place a predecided (non-captain) player or a female player into a team - admin only, costs nothing
router.post('/players/:id/assign', requireAdmin, (req, res) => {
  try { squad.assignPlayer(req.params.id, req.body.team_id); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});
router.post('/players/:id/unassign', requireAdmin, (req, res) => {
  try { squad.unassignPlayer(req.params.id); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});

router.put('/players/:id', requireAdmin, (req, res) => {
  store.players.update(req.params.id, req.body);
  res.json({ ok: true });
});
router.delete('/players/:id', requireAdmin, (req, res) => {
  store.players.remove(req.params.id);
  res.json({ ok: true });
});

// --- Bulk photo upload: files named Full_Name.ext are matched to players by name ---
router.post('/players/photos/bulk-upload', requireAdmin, bulkPhotoUpload.array('photos', 300), (req, res) => {
  const allPlayers = store.players.all();
  const matched = [], unmatched = [], ambiguous = [];

  for (const file of (req.files || [])) {
    const ext = path.extname(file.originalname) || '.jpg';
    const normalized = sanitizeFileName(path.basename(file.originalname, path.extname(file.originalname)));
    const candidates = allPlayers.filter(p => sanitizeFileName(p.full_name) === normalized);

    if (candidates.length === 1) {
      const finalName = normalized + ext.toLowerCase();
      const dir = path.join(__dirname, '..', 'uploads', 'players');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(file.path, path.join(dir, finalName));
      store.players.update(candidates[0].id, { photo_path: path.join('uploads', 'players', finalName) });
      matched.push({ file: file.originalname, player: candidates[0].full_name });
    } else if (candidates.length === 0) {
      fs.unlinkSync(file.path);
      unmatched.push(file.originalname);
    } else {
      fs.unlinkSync(file.path);
      ambiguous.push({ file: file.originalname, candidates: candidates.map(c => `${c.full_name} (id ${c.id})`) });
    }
  }
  res.json({ matched, unmatched, ambiguous });
});

// --- Unsold-player distribution (rules 12-13) ---
router.get('/unsold', requireAdmin, (req, res) => res.json(store.players.byStatus('unsold')));

router.post('/unsold/request', requireAdmin, (req, res) => {
  store.unsoldRequests.add({ player_id: req.body.player_id, team_id: req.body.team_id });
  res.json({ ok: true });
});
router.get('/unsold/:playerId/requests', requireAdmin, (req, res) => {
  res.json(store.unsoldRequests.forPlayer(req.params.playerId).map(r => ({
    ...r, team_name: (store.teams.get(r.team_id) || {}).name || '—'
  })));
});
router.post('/unsold/:playerId/allocate', requireAdmin, (req, res) => {
  const requests = store.unsoldRequests.forPlayer(req.params.playerId);
  if (requests.length === 0) return res.status(400).json({ error: 'No requests for this player.' });
  const winner = requests[Math.floor(Math.random() * requests.length)];
  const player = store.players.get(req.params.playerId);
  store.players.update(player.id, {
    status: 'allocated', sold_team_id: winner.team_id, sold_price: player.base_price, round_sold: 3
  });
  store.teams.adjustPurse(winner.team_id, -player.base_price);
  store.unsoldRequests.clearForPlayer(player.id);
  res.json({ winnerTeamId: winner.team_id, candidates: requests.map(r => r.team_id) });
});

// --- Transfers / swaps (rules 11, 14-17) ---
router.get('/transfers', requireAdmin, (req, res) => {
  const list = [...store.transfers.all()].sort((a, b) => new Date(b.reported_at) - new Date(a.reported_at));
  res.json(list.map(t => ({
    ...t,
    full_name: (store.players.get(t.player_id) || {}).full_name || '—',
    from_team: t.from_team_id ? (store.teams.get(t.from_team_id) || {}).name : null,
    to_team: t.to_team_id ? (store.teams.get(t.to_team_id) || {}).name : null
  })));
});
router.post('/transfers', requireAdmin, (req, res) => {
  const { player_id, to_team_id, transfer_type, notes } = req.body;
  const player = store.players.get(player_id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (player.is_captain) return res.status(400).json({ error: 'Captains cannot be transferred.' });
  const toTeam = store.teams.get(to_team_id);
  if (!toTeam) return res.status(400).json({ error: 'Choose a team to transfer to.' });
  const price = player.sold_price || 0;
  const from_team_id = player.sold_team_id;

  // Rule 17: the receiving team must still have purse room for this player.
  if (price > toTeam.purse_remaining) {
    return res.status(400).json({ error: `${toTeam.name} does not have enough purse room for this transfer.` });
  }
  store.players.update(player.id, { sold_team_id: toTeam.id });
  if (from_team_id) store.teams.adjustPurse(from_team_id, price);
  store.teams.adjustPurse(toTeam.id, -price);
  store.transfers.add({ player_id, from_team_id, to_team_id, transfer_type, notes });
  res.json({ ok: true });
});

// --- Dashboard summary ---
router.get('/summary', requireAdmin, (req, res) => {
  const all = store.players.all();
  const count = s => all.filter(p => p.status === s).length;
  res.json({
    pending: count('pending'), sold: count('sold'), round2_pending: count('round2_pending'),
    unsold: count('unsold'), allocated: count('allocated'), reserved: count('reserved'),
    assigned: count('assigned'), total: all.length
  });
});

module.exports = router;
