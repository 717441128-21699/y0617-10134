const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'complaints.db');

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('数据库连接失败:', err.message);
  } else {
    console.log('数据库连接成功');
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA foreign_keys = ON');
  }
});

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function initDatabase() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      real_name TEXT NOT NULL,
      id_card TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'citizen',
      department_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    )`,
    `CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      code TEXT NOT NULL UNIQUE,
      department_id INTEGER NOT NULL,
      description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id)
    )`,
    `CREATE TABLE IF NOT EXISTS areas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      level INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      type_id INTEGER NOT NULL,
      area_id INTEGER NOT NULL,
      citizen_id INTEGER NOT NULL,
      department_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      staff_id INTEGER,
      urgency TEXT NOT NULL DEFAULT 'normal',
      deadline DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (type_id) REFERENCES complaint_types(id),
      FOREIGN KEY (area_id) REFERENCES areas(id),
      FOREIGN KEY (citizen_id) REFERENCES users(id),
      FOREIGN KEY (department_id) REFERENCES departments(id),
      FOREIGN KEY (staff_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS complaint_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      file_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS progress_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL,
      operator_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      remark TEXT,
      old_status TEXT,
      new_status TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
      FOREIGN KEY (operator_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      complaint_id INTEGER,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE SET NULL
    )`,
    `CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id INTEGER NOT NULL UNIQUE,
      citizen_id INTEGER NOT NULL,
      rating INTEGER NOT NULL,
      content TEXT,
      is_review_requested INTEGER NOT NULL DEFAULT 0,
      review_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id) ON DELETE CASCADE,
      FOREIGN KEY (citizen_id) REFERENCES users(id)
    )`,
    `CREATE TABLE IF NOT EXISTS hotspots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      area_id INTEGER NOT NULL,
      complaint_count INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (type_id) REFERENCES complaint_types(id),
      FOREIGN KEY (area_id) REFERENCES areas(id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_department ON complaints(department_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_citizen ON complaints(citizen_id)`,
    `CREATE INDEX IF NOT EXISTS idx_complaints_type_area ON complaints(type_id, area_id)`,
    `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read)`
  ];

  for (const sql of tables) {
    await run(sql);
  }

  const deptCount = await get('SELECT COUNT(*) as count FROM departments');
  if (deptCount.count === 0) {
    const departments = [
      ['城市管理局', 'CG', '负责市容环境、市政设施、违法建筑等管理'],
      ['交通运输局', 'JT', '负责道路交通、公共交通等管理'],
      ['生态环境局', 'HB', '负责环境保护、污染治理等管理'],
      ['公安局', 'GA', '负责社会治安、噪音扰民等管理'],
      ['住房和城乡建设局', 'ZJ', '负责住房保障、城乡建设等管理'],
      ['市场监督管理局', 'SC', '负责市场秩序、消费者权益等管理'],
      ['文化广电旅游局', 'WL', '负责文化市场、旅游服务等管理'],
      ['卫生健康委员会', 'WJ', '负责公共卫生、医疗服务等管理']
    ];

    for (const d of departments) {
      await run('INSERT INTO departments (name, code, description) VALUES (?, ?, ?)', d);
    }

    const types = [
      ['道路破损', 'DLPS', 2, '路面坑洼、井盖缺失、路灯损坏等'],
      ['噪音扰民', 'ZYRM', 4, '施工噪音、商业噪音、生活噪音等'],
      ['违章建筑', 'WZJZ', 1, '违法搭建、占用公共空间等'],
      ['环境污染', 'HJWR', 3, '污水排放、废气污染、垃圾乱堆等'],
      ['交通拥堵', 'JTYS', 2, '道路拥堵、交通设施故障等'],
      ['市容脏乱', 'SRZL', 1, '垃圾清运不及时、小广告乱贴等'],
      ['物业纠纷', 'WYJF', 5, '物业服务、小区管理等问题'],
      ['消费纠纷', 'XFJF', 6, '商品质量、服务态度等问题'],
      ['旅游投诉', 'LYTS', 7, '旅游服务、景区管理等问题'],
      ['医疗卫生', 'YLWS', 8, '医疗服务、公共卫生等问题'],
      ['占道经营', 'ZDJY', 1, '流动摊贩、店外经营等'],
      ['绿化破坏', 'LHPH', 1, '树木损坏、绿地占用等']
    ];

    for (const t of types) {
      await run('INSERT INTO complaint_types (name, code, department_id, description) VALUES (?, ?, ?, ?)', t);
    }

    const areas = [
      ['东城区', 'DCQ', null, 1],
      ['西城区', 'XCQ', null, 1],
      ['朝阳区', 'CYQ', null, 1],
      ['海淀区', 'HDQ', null, 1],
      ['丰台区', 'FTQ', null, 1],
      ['石景山区', 'SJSQ', null, 1],
      ['东直门街道', 'DZM', 1, 2],
      ['朝阳门街道', 'CYM', 1, 2],
      ['建国门街道', 'JGM', 1, 2],
      ['西长安街街道', 'XCA', 2, 2],
      ['新街口街道', 'XJK', 2, 2],
      ['月坛街道', 'YT', 2, 2],
      ['三里屯街道', 'SLT', 3, 2],
      ['望京街道', 'WJ', 3, 2],
      ['CBD街道', 'CBD', 3, 2],
      ['中关村街道', 'ZGC', 4, 2],
      ['海淀街道', 'HD', 4, 2],
      ['学院路街道', 'XYL', 4, 2]
    ];

    for (const a of areas) {
      await run('INSERT INTO areas (name, code, parent_id, level) VALUES (?, ?, ?, ?)', a);
    }

    const hashedAdmin = bcrypt.hashSync('admin123', 10);
    const hashedStaff = bcrypt.hashSync('staff123', 10);
    const hashedCitizen = bcrypt.hashSync('user123', 10);

    const users = [
      ['系统管理员', '110101199001010001', '13800000001', hashedAdmin, 'admin', null],
      ['张管理', '110101199001010002', '13800000002', hashedStaff, 'staff', 1],
      ['李执法', '110101199001010003', '13800000003', hashedStaff, 'staff', 2],
      ['王环保', '110101199001010004', '13800000004', hashedStaff, 'staff', 3],
      ['赵警官', '110101199001010005', '13800000005', hashedStaff, 'staff', 4],
      ['陈市民', '110101199001010006', '13800000006', hashedCitizen, 'citizen', null],
      ['刘市民', '110101199001010007', '13800000007', hashedCitizen, 'citizen', null],
      ['周市民', '110101199001010008', '13800000008', hashedCitizen, 'citizen', null]
    ];

    for (const u of users) {
      await run('INSERT INTO users (real_name, id_card, phone, password, role, department_id) VALUES (?, ?, ?, ?, ?, ?)', u);
    }

    console.log('数据库初始化完成，已插入初始数据');
  }
}

function getDB() {
  return { run, get, all, db };
}

module.exports = { initDatabase, getDB };
