const { getDB } = require('../database');
const { notifyAdmins, notifyDepartmentStaff, notifyAssignedStaff } = require('./notifications');

const NORMAL_DEADLINE_DAYS = 7;
const URGENT_DEADLINE_DAYS = 3;

function calculateDeadline(urgency) {
  const days = urgency === 'urgent' ? URGENT_DEADLINE_DAYS : NORMAL_DEADLINE_DAYS;
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function checkOverdueComplaints() {
  const { all, get, run } = getDB();
  
  const overdue = await all(`
    SELECT c.*, ct.name as type_name, a.name as area_name,
           u.real_name as citizen_name, d.name as department_name,
           s.real_name as staff_name
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN users u ON c.citizen_id = u.id
    JOIN departments d ON c.department_id = d.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE c.status IN ('pending', 'assigned', 'processing')
    AND c.deadline < datetime('now')
  `);

  for (const complaint of overdue) {
    const warnCountResult = await get(`
      SELECT COUNT(*) as count FROM progress_logs
      WHERE complaint_id = ? AND action = 'overdue_warning'
    `, [complaint.id]);
    const warnCount = warnCountResult.count;

    if (warnCount === 0) {
      await run(`
        INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
        VALUES (?, 0, 'overdue_warning', ?, ?, ?)
      `, [
        complaint.id,
        `工单已逾期，请尽快处理`,
        complaint.status,
        complaint.status
      ]);

      await notifyAdmins(
        '工单逾期提醒',
        `工单 #${complaint.id} [${complaint.title}] 已逾期，请督办`,
        complaint.id
      );

      await notifyDepartmentStaff(
        complaint.department_id,
        '工单逾期提醒',
        `您部门的工单 #${complaint.id} [${complaint.title}] 已逾期，请尽快处理`,
        complaint.id
      );

      if (complaint.staff_id) {
        await notifyAssignedStaff(
          complaint.id,
          '工单逾期提醒',
          `您负责的工单 #${complaint.id} [${complaint.title}] 已逾期，请尽快处理`
        );
      }

      console.log(`已发送逾期提醒: 工单 #${complaint.id}`);
    }
  }

  return overdue;
}

async function getOverdueComplaints() {
  const { all } = getDB();
  return await all(`
    SELECT c.*, ct.name as type_name, a.name as area_name,
           u.real_name as citizen_name, d.name as department_name,
           s.real_name as staff_name,
           julianday('now') - julianday(c.deadline) as overdue_days
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN users u ON c.citizen_id = u.id
    JOIN departments d ON c.department_id = d.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE c.status IN ('pending', 'assigned', 'processing')
    AND c.deadline < datetime('now')
    ORDER BY c.deadline ASC
  `);
}

async function getUrgentComplaints() {
  const { all } = getDB();
  return await all(`
    SELECT c.*, ct.name as type_name, a.name as area_name,
           u.real_name as citizen_name, d.name as department_name,
           s.real_name as staff_name,
           julianday(c.deadline) - julianday('now') as days_left
    FROM complaints c
    JOIN complaint_types ct ON c.type_id = ct.id
    JOIN areas a ON c.area_id = a.id
    JOIN users u ON c.citizen_id = u.id
    JOIN departments d ON c.department_id = d.id
    LEFT JOIN users s ON c.staff_id = s.id
    WHERE c.status IN ('pending', 'assigned', 'processing')
    AND c.urgency = 'urgent'
    ORDER BY c.deadline ASC
  `);
}

async function extendDeadline(complaintId, days, operatorId, reason) {
  const { get, run } = getDB();
  const complaint = await get('SELECT * FROM complaints WHERE id = ?', [complaintId]);
  
  if (!complaint) {
    throw new Error('工单不存在');
  }

  const newDeadline = new Date(complaint.deadline);
  newDeadline.setDate(newDeadline.getDate() + days);
  
  await run(`
    UPDATE complaints SET deadline = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [newDeadline.toISOString().slice(0, 19).replace('T', ' '), complaintId]);

  await run(`
    INSERT INTO progress_logs (complaint_id, operator_id, action, remark, old_status, new_status)
    VALUES (?, ?, 'extend_deadline', ?, ?, ?)
  `, [
    complaintId,
    operatorId,
    `延期 ${days} 天，原因：${reason}`,
    complaint.status,
    complaint.status
  ]);

  return { success: true, newDeadline };
}

module.exports = {
  calculateDeadline,
  checkOverdueComplaints,
  getOverdueComplaints,
  getUrgentComplaints,
  extendDeadline,
  NORMAL_DEADLINE_DAYS,
  URGENT_DEADLINE_DAYS
};
