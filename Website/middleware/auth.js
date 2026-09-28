function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  if (req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.redirect('/admin/login.html');
}

module.exports = { requireAdmin };
