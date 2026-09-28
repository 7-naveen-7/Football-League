const store = require('../db/dataStore');
const { RULES, nextBidAmount, canAffordNextBid, formatMoney } = require('./biddingRules');

let io = null;
function attachIO(socketIoInstance) { io = socketIoInstance; }

// The countdown is purely informational: when it reaches zero NOTHING happens
// automatically. The admin decides Sold / Unsold. The server only stores when the
// current window ends (timer_ends_at) and how long it was (timer_total_ms); the
// screens tick the countdown themselves.

// Only what the public screen needs - no emails / roll numbers.
function publicPlayer(p) {
  if (!p) return null;
  const { id, full_name, category, experience, preferred_positions, favourite_club, photo_path, base_price } = p;
  return { id, full_name, category, experience, preferred_positions, favourite_club, photo_path, base_price };
}

function getFullState() {
  const state = store.state.get();
  const currentPlayer = state.current_player_id ? publicPlayer(store.players.get(state.current_player_id)) : null;
  // female_count is admin-only, so it's stripped from everything that reaches the live screen.
  const teams = store.teams.withCounts().map(({ female_count, ...t }) => t);
  return { state, currentPlayer, teams, server_time: Date.now() };
}

function broadcast() { if (io) io.emit('state-update', getFullState()); }

const queueStatus = round => (round === 1 ? 'pending' : 'round2_pending');

function armTimer(seconds) {
  const ms = seconds * 1000;
  store.state.update({ timer_total_ms: ms, timer_ends_at: Date.now() + ms, timer_remaining_ms: null });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Rule 1: Advance -> Intermediate -> Beginner by default, shuffled within each category.
// Display males in their original Excel import order without any additional sorting or shuffling
function buildAuctionOrder(round) {
  const pool = store.players.byStatus(queueStatus(round)).filter(p => p.gender !== 'Female');
  // Returns the players exactly in the order they were parsed from the sheet
  return pool.map(p => p.id);
}

function putUp(player, count) {
  store.players.update(player.id, { status: 'in_auction' });
  store.state.update({
    status: 'running', current_player_id: player.id, current_bid: null,
    current_bid_team_id: null, players_auctioned_count: count
  });
  armTimer(RULES.FIRST_BID_SECONDS);
  broadcast();
}

function finish(count) {
  store.state.update({
    status: 'finished', current_player_id: null, current_bid: null, current_bid_team_id: null,
    timer_ends_at: null, timer_total_ms: null, timer_remaining_ms: null, players_auctioned_count: count
  });
  broadcast();
}

function startAuction(round = 1, categoryOrder) {
  round = Number(round) === 2 ? 2 : 1;
  // Restarting: whoever was on the block goes back into the queue they came from.
  const previousRound = store.state.get().round;
  store.players.byStatus('in_auction').forEach(p =>
    store.players.update(p.id, { status: queueStatus(previousRound) }));

  const order = buildAuctionOrder(round, categoryOrder);
  if (order.length === 0) throw new Error('No players available to auction in this round.');
  order.forEach((id, i) => store.players.update(id, { auction_order: i + 1 }));

  store.state.update({ round, players_auctioned_count: 0 });
  putUp(store.players.get(order[0]), 0);
}

function placeBid(teamId) {
  teamId = Number(teamId);
  const state = store.state.get();
  if (state.status !== 'running' || !state.current_player_id) {
    throw new Error('No active player to bid on right now (is the auction paused?).');
  }
  const team = store.teams.get(teamId);
  if (!team) throw new Error('Unknown team.');
  if (state.current_bid_team_id === teamId) throw new Error('This team already holds the current highest bid.');

  const player = store.players.get(state.current_player_id);
  const currentBid = state.current_bid || player.base_price;
  const amount = nextBidAmount(currentBid);

  // Rule 9
  if (!canAffordNextBid(team, currentBid)) {
    throw new Error(`${team.name} cannot afford the minimum raise to ${formatMoney(amount)}.`);
  }
  // Rule 3: max 16 players won through the auction (captain / predecided / females don't count)
  const won = store.players.all().filter(p => p.sold_team_id === teamId && (p.round_sold === 1 || p.round_sold === 2)).length;
  if (won >= RULES.MAX_ACQUIRE_IN_AUCTION) {
    throw new Error(`${team.name} has already reached the ${RULES.MAX_ACQUIRE_IN_AUCTION}-player auction cap.`);
  }

  store.state.update({ current_bid: amount, current_bid_team_id: teamId });
  store.bids.add({ player_id: state.current_player_id, team_id: teamId, amount, round: state.round });
  armTimer(RULES.BID_TIME_SECONDS); // rule 6: fresh window after every valid bid
  broadcast();
  return amount;
}

function markSold() {
  const state = store.state.get();
  if (!state.current_player_id || !state.current_bid_team_id) {
    throw new Error('No winning bid to finalize - use "Mark Unsold" instead.');
  }
  const team = store.teams.get(state.current_bid_team_id);
  store.players.update(state.current_player_id, {
    status: 'sold', sold_team_id: state.current_bid_team_id,
    sold_price: state.current_bid, round_sold: state.round
  });
  store.teams.adjustPurse(state.current_bid_team_id, -state.current_bid);

  if (io) io.emit('player-sold-event', { teamName: team ? team.name : '', amount: state.current_bid });
  
  // Wait 2.2 seconds for the display animation to finish before loading the next player
  setTimeout(() => {
    advanceToNextPlayer(state.round);
  }, 2200);
}

function declareUnsold() {
  const state = store.state.get();
  if (!state.current_player_id) throw new Error('No active player.');
  store.players.update(state.current_player_id, { status: state.round === 1 ? 'round2_pending' : 'unsold' });

  if (io) io.emit('player-unsold-event', {});
  
  // Wait 2.2 seconds for the display animation to finish before loading the next player
  setTimeout(() => {
    advanceToNextPlayer(state.round);
  }, 2200);
}

function advanceToNextPlayer(round) {
  const count = store.state.get().players_auctioned_count + 1;
  const next = store.players.nextInQueue(queueStatus(round));

  if (!next) return finish(count);

  // Rule 10: 2-minute break after every 15 players.
  if (count % RULES.BREAK_AFTER_PLAYERS === 0) {
    const ms = RULES.BREAK_DURATION_SECONDS * 1000;
    store.state.update({
      status: 'break', current_player_id: null, current_bid: null, current_bid_team_id: null,
      timer_total_ms: ms, timer_ends_at: Date.now() + ms, timer_remaining_ms: null,
      players_auctioned_count: count
    });
    return broadcast();
  }
  putUp(next, count);
}

function resumeFromBreak() {
  const state = store.state.get();
  if (state.status !== 'break') throw new Error('The auction is not on a break.');
  const next = store.players.nextInQueue(queueStatus(state.round));
  if (!next) return finish(state.players_auctioned_count);
  putUp(next, state.players_auctioned_count); // count was already incremented when the break began
}

function pauseAuction() {
  const state = store.state.get();
  if (state.status !== 'running') throw new Error('The auction is not running.');
  const remaining = state.timer_ends_at ? Math.max(0, state.timer_ends_at - Date.now()) : 0;
  store.state.update({ status: 'paused', timer_remaining_ms: remaining, timer_ends_at: null });
  broadcast();
}

function resumeAuction() {
  const state = store.state.get();
  if (state.status !== 'paused') throw new Error('The auction is not paused.');
  store.state.update({ status: 'running', timer_ends_at: Date.now() + (state.timer_remaining_ms || 0), timer_remaining_ms: null });
  broadcast();
}

module.exports = {
  attachIO, broadcast, getFullState,
  startAuction, placeBid, markSold, declareUnsold,
  pauseAuction, resumeAuction, resumeFromBreak
};
