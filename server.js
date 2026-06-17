require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initDatabase } = require('./database');
const { checkOverdueComplaints } = require('./utils/supervision');
const { scanAndUpdateHotspots } = require('./utils/hotspot');

const authRoutes = require('./routes/auth');
const commonRoutes = require('./routes/common');
const complaintRoutes = require('./routes/complaints');
const notificationRoutes = require('./routes/notifications');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

(async function() {
  await initDatabase();
})();

app.use('/api/auth', authRoutes);
app.use('/api/common', commonRoutes);
app.use('/api/complaints', complaintRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/admin', adminRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

setInterval(async () => {
  try {
    await checkOverdueComplaints();
  } catch (err) {
    console.error('逾期检查失败:', err);
  }
}, 60 * 60 * 1000);

setInterval(async () => {
  try {
    await scanAndUpdateHotspots();
  } catch (err) {
    console.error('热点扫描失败:', err);
  }
}, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`城市居民意见与投诉受理平台已启动`);
  console.log(`访问地址: http://localhost:${PORT}`);
  console.log('');
  console.log('测试账号:');
  console.log('  管理员: 13800000001 / admin123');
  console.log('  工作人员: 13800000002 / staff123 (城管局)');
  console.log('  市民: 13800000006 / user123');
  console.log('');
  console.log('公开数据看板: http://localhost:' + PORT + '/dashboard');
});
