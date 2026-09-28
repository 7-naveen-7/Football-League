const engine = require('../services/auctionEngine');

function initSockets(io) {
  engine.attachIO(io);
  io.on('connection', async (socket) => {
    // Send the current snapshot to whoever just connected (admin panel or display screen)
    socket.emit('state-update', await engine.getFullState());
  });
}

module.exports = { initSockets };
