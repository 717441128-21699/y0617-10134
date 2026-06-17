const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDB } = require('../database');
const { authenticateToken, getCurrentUser } = require('../middleware/auth');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { real_name, id_card, phone, password } = req.body;

  if (!real_name || !id_card || !phone || !password) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  if (!/^\d{17}[\dXx]$/.test(id_card)) {
    return res.status(400).json({ error: '身份证号格式不正确' });
  }

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return res.status(400).json({ error: '手机号格式不正确' });
  }

  const { run, get } = getDB();
  const existing = await get('SELECT id FROM users WHERE id_card = ? OR phone = ?', [id_card, phone]);
  
  if (existing) {
    return res.status(400).json({ error: '该身份证号或手机号已注册' });
  }

  const hashedPassword = bcrypt.hashSync(password, 10);

  try {
    const result = await run(`
      INSERT INTO users (real_name, id_card, phone, password, role)
      VALUES (?, ?, ?, ?, 'citizen')
    `, [real_name, id_card, phone, hashedPassword]);

    const token = jwt.sign(
      { id: result.lastID, role: 'citizen' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const user = await getCurrentUser(result.lastID);
    res.json({ token, user });
  } catch (err) {
    res.status(500).json({ error: '注册失败: ' + err.message });
  }
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ error: '请输入手机号和密码' });
  }

  const { get } = getDB();
  const user = await get('SELECT * FROM users WHERE phone = ?', [phone]);

  if (!user) {
    return res.status(401).json({ error: '手机号或密码错误' });
  }

  if (!bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: '手机号或密码错误' });
  }

  const token = jwt.sign(
    { id: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  const userInfo = await getCurrentUser(user.id);
  res.json({ token, user: userInfo });
});

router.get('/me', authenticateToken, async (req, res) => {
  const user = await getCurrentUser(req.user.id);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }
  res.json({ user });
});

router.post('/logout', authenticateToken, (req, res) => {
  res.json({ message: '退出成功' });
});

module.exports = router;
