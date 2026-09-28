// Central place for every numeric rule from the auction rulebook,
// so the whole app reads from one source of truth.

const RULES = {
  BASE_PRICE: { Advance: 40, Intermediate: 20, Beginner: 10 }, // in millions
  TOTAL_PURSE: 1000,                 // fixed for every team (1 billion)
  CURRENCY_SYMBOL: process.env.CURRENCY_SYMBOL || '€', // set CURRENCY_SYMBOL=£ in .env for pounds
  MIN_SQUAD: 8,
  MAX_ACQUIRE_IN_AUCTION: 16,        // rule 3
  MAX_FINAL_SQUAD: 13,               // rule 4 - enforced at transfer-window close
  BID_STEP_MULTIPLE: 5,              // all bids must be multiples of 5M
  FIRST_BID_SECONDS: 20,             // timer when a player is put up (rule 7's 20s)
  BID_TIME_SECONDS: 10,              // timer restarts at this after every bid (rule 6)
  BREAK_AFTER_PLAYERS: 15,           // rule 10
  BREAK_DURATION_SECONDS: 120,
  NUM_TEAMS: 6
};

// e.g. 40 -> "€40M", 1000 -> "€1,000M"
function formatMoney(n) {
  return `${RULES.CURRENCY_SYMBOL}${Number(n).toLocaleString('en-GB')}M`;
}

// Rule 8: minimum raise depends on which band the CURRENT bid falls in.
function minIncrement(currentBid) {
  if (currentBid < 50) return 5;
  if (currentBid < 200) return 10;
  return 20;
}

function nextBidAmount(currentBid) {
  const next = currentBid + minIncrement(currentBid);
  return Math.ceil(next / RULES.BID_STEP_MULTIPLE) * RULES.BID_STEP_MULTIPLE;
}

// Rule 9: a team can't bid if the required raise would exceed its remaining purse.
function canAffordNextBid(team, currentBid) {
  return team.purse_remaining >= nextBidAmount(currentBid);
}

// Soft warning helper (not wired into the UI yet): would winning this bid leave a
// team unable to afford base-price Beginners for its remaining minimum-squad slots?
function purseHealthWarning(team, bidAmount) {
  const playersStillNeeded = Math.max(0, RULES.MIN_SQUAD - (team.players_count || 0) - 1);
  return (team.purse_remaining - bidAmount) < playersStillNeeded * RULES.BASE_PRICE.Beginner;
}

module.exports = { RULES, formatMoney, minIncrement, nextBidAmount, canAffordNextBid, purseHealthWarning };
