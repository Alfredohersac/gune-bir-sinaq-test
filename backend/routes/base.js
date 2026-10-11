const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { verifyToken, adminOnly } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `b_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
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

// GET /api/base - Bütün baza sınaqları
router.get('/', verifyToken, adminOnly, async (req, res) => {
  const { search } = req.query;
  try {
    let query = `SELECT b.*, 
      (SELECT COUNT(*) FROM base_questions WHERE base_exam_id = b.id) as actual_question_count
      FROM base_exams b WHERE 1=1`;
    const params = [];
    if (search) {
      params.push(`%${search}%`);
      query += ` AND b.name ILIKE $${params.length}`;
    }
    query += ' ORDER BY b.created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// POST /api/base - Yeni baza sınağı yarat
router.post('/', verifyToken, adminOnly, async (req, res) => {
  const { name, question_count } = req.body;
  if (!name || !question_count) {
    return res.status(400).json({ error: 'Ad və sual sayı tələb olunur.' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO base_exams (name, question_count, created_by) VALUES ($1, $2, $3) RETURNING *',
      [name, question_count, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// DELETE /api/base/:id - Baza sınağını sil
router.delete('/:id', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    const questions = await pool.query('SELECT image_path FROM base_questions WHERE base_exam_id = $1', [id]);
    for (const q of questions.rows) {
      if (q.image_path) {
        const filePath = path.join(__dirname, '..', q.image_path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    await pool.query('DELETE FROM base_exams WHERE id = $1', [id]);
    res.json({ message: 'Baza sınağı silindi.' });
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// GET /api/base/:id/questions - Baza sınağının sualları
router.get('/:id/questions', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'SELECT * FROM base_questions WHERE base_exam_id = $1 ORDER BY order_number',
      [id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// POST /api/base/:id/questions/bulk - Sualları yadda saxla
router.post('/:id/questions/bulk', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { questions } = req.body;
  if (!questions || !Array.isArray(questions)) {
    return res.status(400).json({ error: 'Suallar tələb olunur.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM base_questions WHERE base_exam_id = $1', [id]);
    for (const q of questions) {
      await client.query(
        'INSERT INTO base_questions (base_exam_id, order_number, image_path, question_type, correct_answer) VALUES ($1, $2, $3, $4, $5)',
        [id, q.order_number, q.image_path, q.question_type, q.correct_answer]
      );
    }
    await client.query('UPDATE base_exams SET question_count = $1 WHERE id = $2', [questions.length, id]);
    await client.query('COMMIT');
    res.json({ message: 'Suallar uğurla təyin edildi.', count: questions.length });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Server xətası.' });
  } finally {
    client.release();
  }
});

// POST /api/base/:id/activate - Baza sınağını aktivləşdir
router.post('/:id/activate', verifyToken, adminOnly, async (req, res) => {
  const { id } = req.params;
  const { name, time_limit_minutes, start_datetime, end_datetime } = req.body;

  if (!name || !time_limit_minutes || !start_datetime || !end_datetime) {
    return res.status(400).json({ error: 'Bütün sahələr tələb olunur.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Baza sınağının suallarını al
    const baseQuestions = await client.query(
      'SELECT * FROM base_questions WHERE base_exam_id = $1 ORDER BY order_number',
      [id]
    );

    if (baseQuestions.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Baza sınağında sual yoxdur. Əvvəlcə sual əlavə edin.' });
    }

    // Mövcud sınaqlara yeni sınaq yarat (kopya)
    const newExam = await client.query(
      'INSERT INTO exam_sets (name, question_count, time_limit_minutes, start_datetime, end_datetime, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, baseQuestions.rows.length, time_limit_minutes, start_datetime, end_datetime, req.user.id]
    );

    const newExamId = newExam.rows[0].id;

    // Sualları kopyala
    for (const q of baseQuestions.rows) {
      await client.query(
        'INSERT INTO questions (exam_set_id, order_number, image_path, question_type, correct_answer) VALUES ($1, $2, $3, $4, $5)',
        [newExamId, q.order_number, q.image_path, q.question_type, q.correct_answer]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ message: 'Sınaq uğurla aktivləşdirildi!', exam: newExam.rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  } finally {
    client.release();
  }
});

// POST /api/base/upload-image - Şəkil yüklə
router.post('/upload-image', verifyToken, adminOnly, upload.single('image'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Şəkil tapılmadı.' });
  }
  res.json({ path: `uploads/${req.file.filename}` });
});

module.exports = router;