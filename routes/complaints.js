const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDB } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { routeComplaint, analyzeComplaintContent } = require('../utils/routing');
const { updateHotspots } = require('../utils/hotspot');
const { calculateDeadline } = require('../utils/supervision');
const { notifyCitizen, notifyDepartmentStaff, notifyAssignedStaff, notifyAdmins } = require('../utils/notifications');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/avi', 'video/mov'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型'));
    }
  }
});

router.post('/analyze', authenticateToken, async (req, res) => {
  const { description } = req.body;
  if (!description) {
    return res.status(400).json({ error: '请提供描述内容' });
  }
  const analysis = await analyzeComplaintContent(description);
  res.json({ analysis });
});

router.post('/', authenticateToken, requireRole('citizen', 'admin'), upload.array('media', 10), async (req, res) => {
  const { title, description, type_id, area_id, urgency = 'normal' } = req.body;
  const citizenId = req.user.id;

  if (!title || !description || !type_id || !area_id) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  const { run, get } = getDB();

  try {
    const routing = await routeComplaint(parseInt(type_id));
    const deadline = calculateDeadline(urgency);

    const result = await run(`
      INSERT INTO complaints (title, description, type_id, area_id, citizen_id, department_id, urgency, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      title,
      description,
      parseInt(type_id),
      parseInt(area_id),
      citizenId,
      routing.departmentId,
      urgency,
      deadline
    ]);

    const complaintId = result.lastID;

    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        await run(`
          INSERT INTO complaint_media (complaint_id, file_path, file_type, file_name)
          VALUES (?, ?, ?, ?)
        `, [
          complaintId,
          file.filename,
          file.mimetype.startsWith('image/') ? 'image' : 'video',
          file.originalname
        ]);
      }
    }

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'create', ?, NULL, 'pending')
    `, [complaintId, citizenId, `市民提交诉求，已自动分派至${routing.departmentName}`]);

    await updateHotspots(parseInt(type_id), parseInt(area_id));

    await notifyDepartmentStaff(
      routing.departmentId,
      '新工单提醒',
      `您部门收到新工单 #${complaintId}: ${title}`,
      complaintId
    );

    await notifyCitizen(
      complaintId,
      '诉求提交成功',
      `您的诉求已提交，工单号 #${complaintId}，已分派至${routing.departmentName}处理`
    );

    const complaint = await get(`
      SELECT c.*, ct.name as type_name, a.name as area_name,
             d.name as department_name, u.real_name as citizen_name
      FROM complaints c
      JOIN complaint_types ct ON c.type_id = ct.id
      JOIN areas a ON c.area_id = a.id
      JOIN departments d ON c.department_id = d.id
      JOIN users u ON c.citizen_id = u.id
      WHERE c.id = ?
    `, [complaintId]);

    res.json({ complaint });
  } catch (err) {
    res.status(500).json({ error: '提交失败: ' + err.message });
  }
});

router.get('/', authenticateToken, async (req, res) => {
  const { all, get } = getDB();
  const { status, type_id, area_id, department_id, page = 1, page_size = 20 } = req.query;
  const userId = req.user.id;
  const userRole = req.user.role;

  let sql = `
    SELECT c.*, ct.name as type_name, a.name as area_name,
           d.name as department_name, u.real_name as citizen_name,
           s.real_name as staff_name
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN departments d ON c.department_id = d.id
    JOIN users u ON c.citizen_id = u.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE 1=1
  `;
  let params = [];

  if (userRole === 'citizen') {
    sql += ' AND c.citizen_id = ?';
    params.push(userId);
  } else if (userRole === 'staff') {
    const user = await get('SELECT department_id FROM users WHERE id = ?', [userId]);
    sql += ' AND c.department_id = ?';
    params.push(user.department_id);
  }

  if (status) {
    sql += ' AND c.status = ?';
    params.push(status);
  }
  if (type_id) {
    sql += ' AND c.type_id = ?';
    params.push(type_id);
  }
  if (area_id) {
    sql += ' AND c.area_id = ?';
    params.push(area_id);
  }
  if (department_id && (userRole === 'admin' || userRole === 'staff')) {
    sql += ' AND c.department_id = ?';
    params.push(department_id);
  }

  const countSql = sql.replace('SELECT c.*', 'SELECT COUNT(*) as count');
  const total = (await get(countSql, params)).count;

  sql += ' ORDER BY c.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(page_size), (parseInt(page) - 1) * parseInt(page_size));

  const complaints = await all(sql, params);

  res.json({
    complaints,
    pagination: {
      page: parseInt(page),
      page_size: parseInt(page_size),
      total,
      total_pages: Math.ceil(total / parseInt(page_size))
    }
  });
});

router.get('/:id', authenticateToken, async (req, res) => {
  const { get, all } = getDB();
  const { id } = req.params;
  const userId = req.user.id;
  const userRole = req.user.role;

  const complaint = await get(`
    SELECT c.*, ct.name as type_name, a.name as area_name,
           d.name as department_name, u.real_name as citizen_name, u.phone as citizen_phone,
           s.real_name as staff_name
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN departments d ON c.department_id = d.id
    JOIN users u ON c.citizen_id = u.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE c.id = ?
  `, [id]);

  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (userRole === 'citizen' && complaint.citizen_id !== userId) {
    return res.status(403).json({ error: '无权查看此工单' });
  }
  if (userRole === 'staff') {
    const user = await get('SELECT department_id FROM users WHERE id = ?', [userId]);
    if (complaint.department_id !== user.department_id) {
      return res.status(403).json({ error: '无权查看此工单' });
    }
  }

  const media = await all('SELECT * FROM complaint_media WHERE complaint_id = ?', [id]);
  const logs = await all(`
    SELECT pl.*, u.real_name as operator_name
    FROM progress_logs pl
    JOIN users u ON pl.operator_id = u.id
    WHERE pl.complaint_id = ?
    ORDER BY pl.created_at ASC
  `, [id]);

  const review = await get('SELECT * FROM reviews WHERE complaint_id = ?', [id]);

  res.json({ complaint, media, logs, review });
});

router.post('/:id/claim', authenticateToken, requireRole('staff'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const staffId = req.user.id;

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  const user = await get('SELECT department_id FROM users WHERE id = ?', [staffId]);
  if (complaint.department_id !== user.department_id) {
    return res.status(403).json({ error: '无权认领此工单' });
  }

  if (complaint.status !== 'pending') {
    return res.status(400).json({ error: '此工单状态不允许认领' });
  }

  try {
    await run(`
      UPDATE complaints SET status = 'assigned', staff_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [staffId, id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'claim', '工作人员认领工单', 'pending', 'assigned')
    `, [id, staffId]);

    await notifyCitizen(id, '工单已认领', `您的工单 #${id} 已由工作人员认领处理`);

    const updated = await get(`
      SELECT c.*, ct.name as type_name, a.name as area_name,
             d.name as department_name, u.real_name as citizen_name,
             s.real_name as staff_name
      FROM complaints c
      JOIN complaint_types ct ON c.type_id = ct.id
      JOIN areas a ON c.area_id = a.id
      JOIN departments d ON c.department_id = d.id
      JOIN users u ON c.citizen_id = u.id
      LEFT JOIN users s ON c.staff_id = s.id
      WHERE c.id = ?
    `, [id]);

    res.json({ complaint: updated });
  } catch (err) {
    res.status(500).json({ error: '认领失败: ' + err.message });
  }
});

router.post('/:id/process', authenticateToken, requireRole('staff', 'admin'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { remark } = req.body;
  const operatorId = req.user.id;

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (!['assigned', 'processing'].includes(complaint.status)) {
    return res.status(400).json({ error: '此工单状态不允许更新进度' });
  }

  try {
    const oldStatus = complaint.status;
    const newStatus = 'processing';

    await run(`
      UPDATE complaints SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newStatus, id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'process', ?, ?, ?)
    `, [id, operatorId, remark || '更新处理进度', oldStatus, newStatus]);

    await notifyCitizen(id, '工单处理中', `您的工单 #${id} 正在处理中：${remark || '工作人员正在处理'}`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '更新失败: ' + err.message });
  }
});

router.post('/:id/complete', authenticateToken, requireRole('staff', 'admin'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { result } = req.body;
  const operatorId = req.user.id;

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (!['processing', 'assigned'].includes(complaint.status)) {
    return res.status(400).json({ error: '此工单状态不允许完成' });
  }

  try {
    const oldStatus = complaint.status;
    const newStatus = 'resolved';

    await run(`
      UPDATE complaints SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [newStatus, id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'complete', ?, ?, ?)
    `, [id, operatorId, result || '处理完成', oldStatus, newStatus]);

    await notifyCitizen(id, '工单已完成', `您的工单 #${id} 已处理完成，请评价处理结果`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '完成失败: ' + err.message });
  }
});

router.post('/:id/review', authenticateToken, requireRole('citizen'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { rating, content } = req.body;
  const citizenId = req.user.id;

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: '请提供有效的评分（1-5星）' });
  }

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (complaint.citizen_id !== citizenId) {
    return res.status(403).json({ error: '无权评价此工单' });
  }

  if (complaint.status !== 'resolved') {
    return res.status(400).json({ error: '此工单尚未处理完成' });
  }

  const existing = await get('SELECT id FROM reviews WHERE complaint_id = ?', [id]);
  if (existing) {
    return res.status(400).json({ error: '此工单已评价过' });
  }

  try {
    await run(`
      INSERT INTO reviews (complaint_id, citizen_id, rating, content)
      VALUES (?, ?, ?, ?)
    `, [id, citizenId, parseInt(rating), content || '']);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'review', ?, 'resolved', 'resolved')
    `, [id, citizenId, `市民评价：${rating}星 - ${content || '无评价内容'}`, 'resolved', 'resolved']);

    if (complaint.staff_id) {
      await notifyAssignedStaff(
        id,
        '工单已评价',
        `工单 #${id} 已获得市民评价：${rating}星`
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '评价失败: ' + err.message });
  }
});

router.post('/:id/request-review', authenticateToken, requireRole('citizen'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { reason } = req.body;
  const citizenId = req.user.id;

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (complaint.citizen_id !== citizenId) {
    return res.status(403).json({ error: '无权申请复查此工单' });
  }

  const review = await get('SELECT * FROM reviews WHERE complaint_id = ?', [id]);
  if (!review) {
    return res.status(400).json({ error: '请先评价处理结果' });
  }

  if (review.is_review_requested) {
    return res.status(400).json({ error: '已申请过复查' });
  }

  try {
    await run(`
      UPDATE reviews SET is_review_requested = 1, review_reason = ?
      WHERE complaint_id = ?
    `, [reason || '', id]);

    await run(`
      UPDATE complaints SET status = 'reviewing', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'request_review', ?, 'resolved', 'reviewing')
    `, [id, citizenId, `申请复查，原因：${reason || '未说明原因'}`, 'resolved', 'reviewing']);

    await notifyAdmins(
      '复查申请',
      `工单 #${id} 市民申请复查，请处理`,
      id
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '申请失败: ' + err.message });
  }
});

router.post('/:id/cancel', authenticateToken, requireRole('citizen', 'admin'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const operatorId = req.user.id;
  const userRole = req.user.role;

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  if (userRole === 'citizen' && complaint.citizen_id !== operatorId) {
    return res.status(403).json({ error: '无权取消此工单' });
  }

  if (!['pending', 'assigned'].includes(complaint.status)) {
    return res.status(400).json({ error: '此工单状态不允许取消' });
  }

  try {
    const oldStatus = complaint.status;

    await run(`
      UPDATE complaints SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'cancel', '市民撤销诉求', ?, 'cancelled')
    `, [id, operatorId, oldStatus]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '取消失败: ' + err.message });
  }
});

module.exports = router;
