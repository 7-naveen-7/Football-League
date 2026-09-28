const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const engine = require('../services/auctionEngine');
const { RULES } = require('../services/biddingRules');

const router = express.Router();

// Public - used by the live display and the admin console
router.get('/state', (req, res) => res.json(engine.getFullState()));
router.get('/config', (req, res) => res.json({ currency: RULES.CURRENCY_SYMBOL, totalPurse: RULES.TOTAL_PURSE }));

// Everything below changes auction state, so it's admin-only. In the room the ADMIN
// clicks these buttons on behalf of whichever captain calls out a bid.
const run = (fn) => (req, res) => {
  try { res.json({ ok: true, ...(fn(req) || {}) }); }
  catch (err) { res.status(400).json({ error: err.message }); }
};

router.post('/start', requireAdmin, run(req => { engine.startAuction(req.body.round || 1, req.body.categoryOrder); }));
router.post('/bid', requireAdmin, run(req => ({ amount: engine.placeBid(req.body.teamId) })));
router.post('/sold', requireAdmin, run(() => { engine.markSold(); }));
router.post('/unsold', requireAdmin, run(() => { engine.declareUnsold(); }));
router.post('/pause', requireAdmin, run(() => { engine.pauseAuction(); }));
router.post('/resume', requireAdmin, run(() => { engine.resumeAuction(); }));
router.post('/resume-from-break', requireAdmin, run(() => { engine.resumeFromBreak(); }));

module.exports = router;
