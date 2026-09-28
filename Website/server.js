require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const adminRoutes = require('./routes/adminRoutes');
const auctionRoutes = require('./routes/auctionRoutes');
const { initSockets } = require('./sockets/auctionSocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8-hour session, plenty for one auction day
}));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use('/display', express.static(path.join(__dirname, 'public', 'display')));

app.use('/api/admin', adminRoutes);
app.use('/api/auction', auctionRoutes);

app.get('/', (req, res) => res.redirect('/display/index.html'));

initSockets(io);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Football Auction server running at http://localhost:${PORT}`);
  console.log(`  Live display : http://localhost:${PORT}/display/index.html`);
  console.log(`  Admin console: http://localhost:${PORT}/admin/login.html`);
});
