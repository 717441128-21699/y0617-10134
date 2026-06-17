const express = require('express');
const { getDB } = require('../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

router.get('/', authenticateToken, async (req, res) => {
  const { all, get } = getDB();
  const userId = req.user.id;
  const { is_read, page = 1, page_size = 20 } = req.query;

  let sql = `
    SELECT n.*, c.title as complaint_title
    FROM notifications n
    LEFT JOIN complaints c ON n.complaint_id = c.id
    WHERE n.user_id = ?
  `;
  let params = [userId];

  if (is_read !== undefined) {
    sql += ' AND n.is_read = ?';
    params.push(is_read === 'true' ? 1 : 0);
  }

  const countSql = sql.replace('SELECT n.*', 'SELECT COUNT(*) as count');
  const total = (await get(countSql, params)).count;

  sql += ' ORDER BY n.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(page_size), (parseInt(page) - 1) * parseInt(page_size));

  const notifications = await all(sql, params);

  res.json({
    notifications,
    pagination: {
      page: parseInt(page),
      page_size: parseInt(page_size),
      total,
      total_pages: Math.ceil(total / parseInt(page_size))
    }
  });
});

router.get('/unread-count', authenticateToken, async (req, res) => {
  const { get } = getDB();
  const userId = req.user.id;

  const result = await get(`
    SELECT COUNT(*) as count FROM notifications
    WHERE user_id = ? AND is_read = 0
  `, [userId]);

  res.json({ unread_count: result.count });
});

router.post('/:id/read', authenticateToken, async (req, res) => {
  const { get, run } = getDB();
  const { id } = req.params;
  const userId = req.user.id;

  const notification = await get('SELECT * FROM notifications WHERE id = ?', [id]);
  if (!notification) {
    return res.status(404).json({ error: '通知不存在' });
  }

  if (notification.user_id !== userId) {
    return res.status(403).json({ error: '无权操作此通知' });
  }

  await run('UPDATE notifications SET is_read = 1 WHERE id = ?', [id]);

  res.json({ success: true });
});

router.post('/read-all', authenticateToken, async (req, res) => {
  const { run } = getDB();
  const userId = req.user.id;

  await run('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0', [userId]);

  res.json({ success: true });
});

module.exports = router;
