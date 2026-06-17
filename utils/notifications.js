const { getDB } = require('../database');

async function sendNotification(userId, title, content, complaintId = null) {
  const { run } = getDB();
  const stmt = await run(`
    INSERT INTO notifications (user_id, complaint_id, title, content)
    VALUES (?, ?, ?, ?)
  `, [userId, complaintId, title, content]);
  return stmt;
}

async function notifyCitizen(complaintId, title, content) {
  const { get } = getDB();
  const complaint = await get(`
    SELECT citizen_id FROM complaints WHERE id = ?
  `, [complaintId]);
  
  if (complaint) {
    await sendNotification(complaint.citizen_id, title, content, complaintId);
  }
}

async function notifyDepartmentStaff(departmentId, title, content, complaintId = null) {
  const { all } = getDB();
  const staffList = await all(`
    SELECT id FROM users WHERE department_id = ? AND role = 'staff'
  `, [departmentId]);
  
  for (const staff of staffList) {
    await sendNotification(staff.id, title, content, complaintId);
  }
}

async function notifyAssignedStaff(complaintId, title, content) {
  const { get } = getDB();
  const complaint = await get(`
    SELECT staff_id FROM complaints WHERE id = ?
  `, [complaintId]);
  
  if (complaint && complaint.staff_id) {
    await sendNotification(complaint.staff_id, title, content, complaintId);
  }
}

async function notifyAdmins(title, content, complaintId = null) {
  const { all } = getDB();
  const admins = await all(`
    SELECT id FROM users WHERE role = 'admin'
  `);
  
  for (const admin of admins) {
    await sendNotification(admin.id, title, content, complaintId);
  }
}

module.exports = {
  sendNotification,
  notifyCitizen,
  notifyDepartmentStaff,
  notifyAssignedStaff,
  notifyAdmins
};
