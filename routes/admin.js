const express = require('express');
const { getDB } = require('../database');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { getOverdueComplaints, getUrgentComplaints, extendDeadline, checkOverdueComplaints } = require('../utils/supervision');
const { scanAndUpdateHotspots, getActiveHotspots } = require('../utils/hotspot');
const { notifyDepartmentStaff, notifyCitizen } = require('../utils/notifications');

const router = express.Router();

router.get('/stats', authenticateToken, requireRole('admin'), async (req, res) => {
  const { get } = getDB();
  
  const totalComplaints = (await get('SELECT COUNT(*) as count FROM complaints')).count;
  const pendingComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'pending'")).count;
  const processingComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status IN ('assigned', 'processing')")).count;
  const resolvedComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'resolved'")).count;
  const reviewingComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'reviewing'")).count;
  const cancelledComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'cancelled'")).count;

  const todayComplaints = (await get(`
    SELECT COUNT(*) as count FROM complaints
    WHERE date(created_at) = date('now')
  `)).count;

  const newUsers = (await get(`
    SELECT COUNT(*) as count FROM users
    WHERE date(created_at) = date('now') AND role = 'citizen'
  `)).count;

  const avgRatingResult = await get('SELECT AVG(rating) as avg FROM reviews WHERE rating > 0');
  const avgRating = avgRatingResult.avg || 0;
  
  const avgResolveDaysResult = await get(`
    SELECT AVG(julianday(updated_at) - julianday(created_at)) as avg
    FROM complaints WHERE status = 'resolved'
  `);
  const avgResolveDays = avgResolveDaysResult.avg || 0;

  const overdue = await getOverdueComplaints();
  const urgent = await getUrgentComplaints();
  const hotspots = await getActiveHotspots();

  res.json({
    overview: {
      total: totalComplaints,
      pending: pendingComplaints,
      processing: processingComplaints,
      resolved: resolvedComplaints,
      reviewing: reviewingComplaints,
      cancelled: cancelledComplaints,
      today: todayComplaints,
      new_users: newUsers,
      avg_rating: Number(avgRating.toFixed(1)),
      avg_resolve_days: Number(avgResolveDays.toFixed(1))
    },
    overdue: {
      count: overdue.length,
      list: overdue.slice(0, 10)
    },
    urgent: {
      count: urgent.length,
      list: urgent.slice(0, 10)
    },
    hotspots: {
      count: hotspots.length,
      list: hotspots
    }
  });
});

router.get('/complaints', authenticateToken, requireRole('admin'), async (req, res) => {
  const { all, get } = getDB();
  const { status, type_id, area_id, department_id, page = 1, page_size = 20 } = req.query;

  let sql = `
    SELECT c.*, ct.name as type_name, a.name as area_name,
           d.name as department_name, u.real_name as citizen_name,
           s.real_name as staff_name,
           CASE WHEN c.deadline < datetime('now') AND c.status IN ('pending', 'assigned', 'processing')
                THEN 1 ELSE 0 END as is_overdue
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN departments d ON c.department_id = d.id
    JOIN users u ON c.citizen_id = u.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE 1=1
  `;
  let params = [];

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
  if (department_id) {
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

router.get('/overdue', authenticateToken, requireRole('admin'), async (req, res) => {
  const overdue = await getOverdueComplaints();
  res.json({ overdue });
});

router.get('/urgent', authenticateToken, requireRole('admin'), async (req, res) => {
  const urgent = await getUrgentComplaints();
  res.json({ urgent });
});

router.post('/scan-overdue', authenticateToken, requireRole('admin'), async (req, res) => {
  const overdue = await checkOverdueComplaints();
  res.json({ processed: overdue.length, overdue });
});

router.post('/scan-hotspots', authenticateToken, requireRole('admin'), async (req, res) => {
  await scanAndUpdateHotspots();
  const hotspots = await getActiveHotspots();
  res.json({ hotspots });
});

router.post('/complaints/:id/extend-deadline', authenticateToken, requireRole('admin'), async (req, res) => {
  const { id } = req.params;
  const { days, reason } = req.body;
  const operatorId = req.user.id;

  if (!days || days < 1) {
    return res.status(400).json({ error: '请提供有效的延期天数' });
  }

  try {
    const result = await extendDeadline(parseInt(id), parseInt(days), operatorId, reason || '管理员督办延期');
    
    await notifyDepartmentStaff(
      null,
      '工单督办',
      `工单 #${id} 已由管理员延期 ${days} 天，请尽快处理`,
      parseInt(id)
    );

    await notifyCitizen(
      parseInt(id),
      '工单处理延期',
      `您的工单 #${id} 处理时间已延期 ${days} 天，原因：${reason || '处理需要更多时间'}`
    );

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/complaints/:id/assign', authenticateToken, requireRole('admin'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { staff_id } = req.body;
  const operatorId = req.user.id;

  if (!staff_id) {
    return res.status(400).json({ error: '请指定处理人员' });
  }

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  const staff = await get('SELECT * FROM users WHERE id = ? AND role = ?', [staff_id, 'staff']);
  if (!staff) {
    return res.status(400).json({ error: '无效的处理人员' });
  }

  if (staff.department_id !== complaint.department_id) {
    return res.status(400).json({ error: '该工作人员不属于对应部门' });
  }

  try {
    await run(`
      UPDATE complaints SET status = 'assigned', staff_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [staff_id, id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'admin_assign', ?, ?, ?)
    `, [id, operatorId, `管理员分派给 ${staff.real_name} 处理`, complaint.status, 'assigned']);

    await notifyCitizen(id, '工单已分派', `您的工单 #${id} 已由管理员分派给工作人员处理`);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '分派失败: ' + err.message });
  }
});

router.post('/complaints/:id/transfer', authenticateToken, requireRole('admin'), async (req, res) => {
  const { run, get } = getDB();
  const { id } = req.params;
  const { department_id, reason } = req.body;
  const operatorId = req.user.id;

  if (!department_id) {
    return res.status(400).json({ error: '请指定目标部门' });
  }

  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [id]);
  if (!complaint) {
    return res.status(404).json({ error: '工单不存在' });
  }

  const department = await get('SELECT * FROM departments WHERE id = ?', [department_id]);
  if (!department) {
    return res.status(400).json({ error: '无效的目标部门' });
  }

  try {
    await run(`
      UPDATE complaints SET department_id = ?, status = 'pending', staff_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `, [department_id, id]);

    await run(`
      INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
      VALUES (?, ?, 'transfer', ?, ?, 'pending')
    `, [id, operatorId, `转派至 ${department.name}，原因：${reason || '部门职责调整'}`, complaint.status]);

    await notifyDepartmentStaff(
      department_id,
      '工单转派',
      `您部门收到转派工单 #${id}: ${complaint.title}`,
      id
    );

    await notifyCitizen(
      id,
      '工单已转派',
      `您的工单 #${id} 已转至 ${department.name} 处理`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '转派失败: ' + err.message });
  }
});

router.get('/departments/stats', authenticateToken, requireRole('admin'), async (req, res) => {
  const { all } = getDB();

  const deptStats = await all(`
    SELECT d.id, d.name, d.code, d.description,
           COUNT(c.id) as total,
           SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END) as resolved,
           SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN c.status = 'processing' OR c.status = 'assigned' THEN 1 ELSE 0 END) as processing,
           SUM(CASE WHEN c.status = 'reviewing' THEN 1 ELSE 0 END) as reviewing,
           SUM(CASE WHEN c.status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
           AVG(r.rating) as avg_rating,
           AVG(CASE WHEN c.status = 'resolved' 
                    THEN julianday(c.updated_at) - julianday(c.created_at) 
                    ELSE NULL END) as avg_resolve_days
    FROM departments d
    LEFT JOIN complaints c ON d.id = c.department_id
    LEFT JOIN reviews r ON c.id = r.complaint_id
    GROUP BY d.id
    ORDER BY total DESC
  `);

  res.json({
    departments: deptStats.map(d => ({
      ...d,
      avg_rating: d.avg_rating ? Number(d.avg_rating.toFixed(1)) : 0,
      avg_resolve_days: d.avg_resolve_days ? Number(d.avg_resolve_days.toFixed(1)) : 0,
      resolution_rate: d.total > 0 ? Number(((d.resolved / d.total) * 100).toFixed(1)) : 0
    }))
  });
});

router.get('/users', authenticateToken, requireRole('admin'), async (req, res) => {
  const { all, get } = getDB();
  const { role, page = 1, page_size = 20 } = req.query;

  let sql = `
    SELECT u.id, u.real_name, u.phone, u.role, u.created_at,
           d.name as department_name
    FROM users u
    LEFT JOIN departments d ON u.department_id = d.id
    WHERE 1=1
  `;
  let params = [];

  if (role) {
    sql += ' AND u.role = ?';
    params.push(role);
  }

  const countSql = sql.replace('SELECT u.id', 'SELECT COUNT(*) as count');
  const total = (await get(countSql, params)).count;

  sql += ' ORDER BY u.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(page_size), (parseInt(page) - 1) * parseInt(page_size));

  const users = await all(sql, params);

  res.json({
    users,
    pagination: {
      page: parseInt(page),
      page_size: parseInt(page_size),
      total,
      total_pages: Math.ceil(total / parseInt(page_size))
    }
  });
});

module.exports = router;
