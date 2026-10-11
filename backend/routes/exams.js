const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { verifyToken, adminOnly } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `q_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Yalnız şəkil faylları qəbul edilir.'));
    }
  }
});

router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, (SELECT COUNT(*) FROM questions WHERE exam_set_id = e.id) as actual_question_count
       FROM exam_sets e ORDER BY e.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.get('/available', verifyToken, async (req, res) => {
  try {
    const now = new Date();
    const result = await pool.query(
      `SELECT e.id, e.name, e.question_count, e.time_limit_minutes,
              e.start_datetime, e.end_datetime,
              (SELECT id FROM user_exam_results
               WHERE user_id = $1 AND exam_set_id = e.id AND is_completed = true) as already_done
       FROM exam_sets e
       WHERE e.start_datetime <= $2 AND e.end_datetime >= $2
       ORDER BY e.start_datetime DESC`,
      [req.user.id, now]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.post('/', verifyToken, adminOnly, async (req, res) => {
  const { name, time_limit_minutes, start_datetime, end_datetime } = req.body;
  if (!name || !time_limit_minutes || !start_datetime || !end_datetime) {
    return res.status(400).json({ error: 'Bütün sahələr tələb olunur.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO exam_sets (name, question_count, time_limit_minutes, start_datetime, end_datetime, created_by)
       VALUES ($1, 0, $2, $3, $4, $5) RETURNING *`,
      [name, time_limit_minutes, start_datetime, end_datetime, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.put('/:id', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { time_limit_minutes, start_datetime, end_datetime } = req.body;
  try {
    const result = await pool.query(
      `UPDATE exam_sets
       SET time_limit_minutes = COALESCE($1, time_limit_minutes),
           start_datetime = COALESCE($2, start_datetime),
           end_datetime = COALESCE($3, end_datetime)
       WHERE id = $4 RETURNING *`,
      [time_limit_minutes, start_datetime, end_datetime, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sınaq dəsti tapılmadı.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.delete('/:id', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    const questions = await pool.query('SELECT image_path FROM questions WHERE exam_set_id = $1', [id]);
    for (const q of questions.rows) {
      if (q.image_path) {
        const filePath = path.join(__dirname, '..', q.image_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    await pool.query('DELETE FROM exam_sets WHERE id = $1', [id]);
    res.json({ message: 'Sınaq dəsti uğurla silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.get('/:id/questions', verifyToken, async (req, res) => {
  const { id } = req.params;
  try {
    let query;
    if (req.user.role === 'admin') {
      query = await pool.query('SELECT * FROM questions WHERE exam_set_id = $1 ORDER BY order_number', [id]);
    } else {
      query = await pool.query(
        'SELECT id, exam_set_id, order_number, image_path, question_type FROM questions WHERE exam_set_id = $1 ORDER BY order_number',
        [id]
      );
    }
    res.json(query.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.post('/:id/questions/bulk', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { questions } = req.body;
  if (!questions || !Array.isArray(questions)) {
    return res.status(400).json({ error: 'Suallar tələb olunur.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM questions WHERE exam_set_id = $1', [id]);
    for (const q of questions) {
      await client.query(
        `INSERT INTO questions (exam_set_id, order_number, image_path, question_type, correct_answer)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, q.order_number, q.image_path, q.question_type, q.correct_answer]
      );
    }
    await client.query('UPDATE exam_sets SET question_count = $1 WHERE id = $2', [questions.length, id]);
    await client.query('COMMIT');
    res.json({ message: 'Suallar uğurla yadda saxlandı.', count: questions.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server xətası.' });
  } finally {
    client.release();
  }
});

router.put('/:examId/questions/:questionId/answer', verifyToken, adminOnly, async (req, res) => {
  const { questionId } = req.params;
  const { correct_answer } = req.body;
  try {
    const result = await pool.query(
      'UPDATE questions SET correct_answer = $1 WHERE id = $2 RETURNING *',
      [correct_answer, questionId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sual tapılmadı.' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.post('/upload-image', verifyToken, adminOnly, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Şəkil tapılmadı.' });
  }
  res.json({ path: `uploads/${req.file.filename}` });
});

module.exports = router;