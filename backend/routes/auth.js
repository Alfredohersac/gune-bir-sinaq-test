const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db/connection');
const { verifyToken, adminOnly } = require('../middleware/auth');
require('dotenv').config();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'İstifadəçi adı və şifrə tələb olunur.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'İstifadəçi adı və ya şifrə yanlışdır.' });
    }
    const user = result.rows[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'İstifadəçi adı və ya şifrə yanlışdır.' });
    }
    if (user.is_blocked) {
      return res.status(403).json({ error: 'Hesab bloklanıb. Adminlə əlaqə saxlayın.' });
    }
    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.post('/create-user', verifyToken, adminOnly, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'İstifadəçi adı və şifrə tələb olunur.' });
  }
  try {
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Bu istifadəçi adı artıq mövcuddur.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password_hash, role, plain_password) VALUES ($1, $2, $3, $4) RETURNING id, username, role',
      [username, passwordHash, role || 'user', password]
    );
    res.status(201).json({ message: 'İstifadəçi uğurla yaradıldı.', user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.get('/users', verifyToken, adminOnly, async (req, res) => {
  const { search, filter } = req.query;
  try {
    let query = 'SELECT id, username, role, is_blocked, plain_password, created_at FROM users WHERE 1=1';
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      query += ` AND (username ILIKE $${params.length} OR id::text ILIKE $${params.length})`;
    }

    if (filter === 'active') {
      query += ' AND is_blocked = false';
    } else if (filter === 'blocked') {
      query += ' AND is_blocked = true';
    }

    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// User blokla / blokdan çıxar
router.put('/users/:id/block', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { is_blocked } = req.body;
  try {
    const result = await pool.query(
      'UPDATE users SET is_blocked = $1 WHERE id = $2 RETURNING id, username, is_blocked',
      [is_blocked, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'İstifadəçi tapılmadı.' });
    }
    res.json({ message: is_blocked ? 'Hesab bloklandı.' : 'Hesab blokdan çıxarıldı.', user: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// User şifrəsini dəyiş
router.put('/users/:id/password', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Yeni şifrə tələb olunur.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, plain_password = $2 WHERE id = $3',
      [passwordHash, password, id]
    );
    res.json({ message: 'Şifrə uğurla dəyişdirildi.' });
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// User sil
router.delete('/users/:id', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({ message: 'İstifadəçi silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

module.exports = router;