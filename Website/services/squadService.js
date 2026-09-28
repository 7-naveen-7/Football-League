// Captains, predecided players and female players are placed into teams by the
// admin (not auctioned) and cost NOTHING - every team's purse stays at the fixed
// total no matter who its captain is.

const store = require('../db/dataStore');

// Put a pre-assigned player back where they came from.
function releasePlayer(p) {
  if (p.sold_team_id && p.sold_price) store.teams.adjustPurse(p.sold_team_id, p.sold_price);
  return store.players.update(p.id, {
    status: (p.gender === 'Female' || p.predecided) ? 'reserved' : 'pending',
    sold_team_id: null, sold_price: null, round_sold: null,
    is_captain: false, assign_type: null
  });
}

// playerId = null clears the team's captain.
function setCaptain(teamId, playerId) {
  const team = store.teams.get(teamId);
  if (!team) throw new Error('Team not found.');

  const previous = team.captain_player_id ? store.players.get(team.captain_player_id) : null;

  if (playerId == null || playerId === '') {
    if (previous && previous.is_captain) releasePlayer(previous);
    store.teams.update(team.id, { captain_player_id: null, captain_name: null });
    return;
  }

  const player = store.players.get(playerId);
  if (!player) throw new Error('Player not found.');
  if (player.gender === 'Female') throw new Error('Captains are chosen from the male players.');
  if (player.is_captain && player.sold_team_id !== team.id) {
    throw new Error(`${player.full_name} is already captain of another team.`);
  }
  if (!['pending', 'reserved', 'assigned'].includes(player.status)) {
    throw new Error(`${player.full_name} is already part of the auction (status: ${player.status}) and can't be made a captain.`);
  }

  if (previous && previous.id !== player.id && previous.is_captain) releasePlayer(previous);

  store.players.update(player.id, {
    status: 'assigned', sold_team_id: team.id, sold_price: 0, round_sold: 0,
    is_captain: true, assign_type: 'captain'
  });
  store.teams.update(team.id, { captain_player_id: player.id, captain_name: player.full_name });
}

// For predecided (non-captain) players and females.
function assignPlayer(playerId, teamId) {
  const player = store.players.get(playerId);
  const team = store.teams.get(teamId);
  if (!player) throw new Error('Player not found.');
  if (!team) throw new Error('Team not found.');
  if (player.is_captain) throw new Error('Captains are set from the Teams tab.');
  if (!['reserved', 'assigned'].includes(player.status)) {
    throw new Error(`${player.full_name} isn't a pre-assigned player (status: ${player.status}).`);
  }
  store.players.update(player.id, {
    status: 'assigned', sold_team_id: team.id, sold_price: 0, round_sold: 0,
    assign_type: player.gender === 'Female' ? 'female' : 'predecided'
  });
}

function unassignPlayer(playerId) {
  const player = store.players.get(playerId);
  if (!player) throw new Error('Player not found.');
  if (player.is_captain) throw new Error('Change or clear the captain from the Teams tab.');
  if (!player.assign_type) throw new Error(`${player.full_name} wasn't pre-assigned.`);
  releasePlayer(player);
}

// Before deleting a team: hand its pre-assigned players back, but refuse if it has bought anyone.
function releaseTeamPlayers(teamId) {
  const squad = store.players.all().filter(p => p.sold_team_id === Number(teamId));
  if (squad.some(p => !p.assign_type)) {
    throw new Error('This team already has auction-acquired players, so it cannot be deleted.');
  }
  squad.forEach(releasePlayer);
}

module.exports = { setCaptain, assignPlayer, unassignPlayer, releaseTeamPlayers, releasePlayer };
