const express = require('express');
const router = express.Router();
const pool = require('../db/connection');
const { verifyToken, adminOnly } = require('../middleware/auth');

router.post('/start', verifyToken, async (req, res) => {
  const { exam_set_id } = req.body;
  const userId = req.user.id;
  try {
    const existing = await pool.query(
      'SELECT * FROM user_exam_results WHERE user_id = $1 AND exam_set_id = $2',
      [userId, exam_set_id]
    );
    if (existing.rows.length > 0 && existing.rows[0].is_completed) {
      return res.status(409).json({ error: 'Bu sınağı artıq işləmisiniz.' });
    }
    const exam = await pool.query(
      'SELECT * FROM exam_sets WHERE id = $1 AND start_datetime <= NOW() AND end_datetime >= NOW()',
      [exam_set_id]
    );
    if (exam.rows.length === 0) {
      return res.status(404).json({ error: 'Sınaq mövcud deyil və ya müddəti bitib.' });
    }
    if (existing.rows.length === 0) {
      const result = await pool.query(
        `INSERT INTO user_exam_results (user_id, exam_set_id, total_questions)
         VALUES ($1, $2, $3) RETURNING *`,
        [userId, exam_set_id, exam.rows[0].question_count]
      );
      return res.status(201).json({ result_id: result.rows[0].id, exam: exam.rows[0] });
    }
    res.json({ result_id: existing.rows[0].id, exam: exam.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.post('/:resultId/submit', verifyToken, async (req, res) => {
  const { resultId } = req.params;
  const { answers } = req.body;
  const userId = req.user.id;
  try {
    const resultCheck = await pool.query(
      'SELECT * FROM user_exam_results WHERE id = $1 AND user_id = $2',
      [resultId, userId]
    );
    if (resultCheck.rows.length === 0) {
      return res.status(403).json({ error: 'İcazə yoxdur.' });
    }
    if (resultCheck.rows[0].is_completed) {
      return res.status(409).json({ error: 'Sınaq artıq tamamlanıb.' });
    }
    const examId = resultCheck.rows[0].exam_set_id;
    const questions = await pool.query(
      'SELECT id, question_type, correct_answer FROM questions WHERE exam_set_id = $1 ORDER BY order_number',
      [examId]
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let correctCount = 0;
      let wrongCount = 0;
      let unansweredCount = 0;
      const detailedResults = [];
      await client.query('DELETE FROM user_answers WHERE result_id = $1', [resultId]);
      for (const question of questions.rows) {
        const userAnswerObj = answers ? answers.find(a => a.question_id == question.id) : null;
        const userAnswer = userAnswerObj ? userAnswerObj.user_answer : null;
        let isCorrect = null;
        if (!userAnswer || userAnswer.trim() === '') {
          unansweredCount++;
        } else {
          if (question.question_type === 'multiple_choice') {
            isCorrect = userAnswer.toLowerCase() === question.correct_answer.toLowerCase();
          } else {
            const userNum = parseFloat(userAnswer);
            const correctNum = parseFloat(question.correct_answer);
            isCorrect = !isNaN(userNum) && !isNaN(correctNum) && Math.abs(userNum - correctNum) < 0.001;
          }
          if (isCorrect) correctCount++;
          else wrongCount++;
        }
        await client.query(
          `INSERT INTO user_answers (result_id, question_id, user_answer, is_correct)
           VALUES ($1, $2, $3, $4)`,
          [resultId, question.id, userAnswer, isCorrect]
        );
        detailedResults.push({
          question_id: question.id,
          user_answer: userAnswer,
          correct_answer: question.correct_answer,
          question_type: question.question_type,
          is_correct: isCorrect,
          is_unanswered: !userAnswer || userAnswer.trim() === ''
        });
      }
      await client.query(
        `UPDATE user_exam_results
         SET is_completed = true, finished_at = NOW(),
             correct_count = $1, wrong_count = $2, unanswered_count = $3
         WHERE id = $4`,
        [correctCount, wrongCount, unansweredCount, resultId]
      );
      await client.query('COMMIT');
      res.json({
        message: 'Sınaq tamamlandı.',
        summary: { correct: correctCount, wrong: wrongCount, unanswered: unansweredCount, total: questions.rows.length },
        details: detailedResults
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

router.get('/my', verifyToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(
      `SELECT uer.*, es.name as exam_name
       FROM user_exam_results uer
       JOIN exam_sets es ON uer.exam_set_id = es.id
       WHERE uer.user_id = $1 AND uer.is_completed = true
       ORDER BY uer.finished_at DESC`,
      [userId]
    );
    let uon = 0;
    if (result.rows.length > 0) {
      const totalRatio = result.rows.reduce((sum, r) => {
        return sum + (r.total_questions > 0 ? r.correct_count / r.total_questions : 0);
      }, 0);
      uon = Math.round((totalRatio / result.rows.length) * 100);
    }
    res.json({ results: result.rows, uon });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// GET /api/results/detail/:examSetId - Detallı nəticə (24 saat ərzində)
router.get('/detail/:examSetId', verifyToken, async (req, res) => {
  const { examSetId } = req.params;
  const userId = req.user.id;

  try {
    // Nəticəni tap
    const resultCheck = await pool.query(
      `SELECT * FROM user_exam_results 
       WHERE user_id = $1 AND exam_set_id = $2 AND is_completed = true`,
      [userId, examSetId]
    );

    if (resultCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Nəticə tapılmadı.' });
    }

    const result = resultCheck.rows[0];

    // 24 saat yoxla
    const finishedAt = new Date(result.finished_at);
    const now = new Date();
    const hoursPassed = (now - finishedAt) / (1000 * 60 * 60);

    if (hoursPassed > 24) {
      return res.status(403).json({ error: 'Baxış müddəti (24 saat) bitib.' });
    }

    // Sualları və cavabları al
    const detail = await pool.query(
      `SELECT q.id, q.order_number, q.image_path, q.question_type, q.correct_answer,
              ua.user_answer, ua.is_correct
       FROM questions q
       LEFT JOIN user_answers ua ON ua.question_id = q.id AND ua.result_id = $1
       WHERE q.exam_set_id = $2
       ORDER BY q.order_number`,
      [result.id, examSetId]
    );

    const rows = detail.rows.map(r => ({
      ...r,
      is_unanswered: !r.user_answer || r.user_answer.trim() === ''
    }));

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

// GET /api/results/stats/:examSetId - Sınaq statistikası
router.get('/stats/:examSetId', verifyToken, adminOnly, async (req, res) => {
  const { examSetId } = req.params;
  try {
    const result = await pool.query(
      `SELECT u.username, uer.correct_count, uer.total_questions,
              uer.started_at, uer.finished_at,
              EXTRACT(EPOCH FROM (uer.finished_at - uer.started_at)) as duration_seconds
       FROM user_exam_results uer
       JOIN users u ON u.id = uer.user_id
       WHERE uer.exam_set_id = $1 AND uer.is_completed = true
       ORDER BY uer.finished_at DESC`,
      [examSetId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server xətası.' });
  }
});

module.exports = router;