const express = require('express');
const { getDB } = require('../database');
const { getTypeDepartmentMap } = require('../utils/routing');
const { getActiveHotspots } = require('../utils/hotspot');

const router = express.Router();

router.get('/departments', async (req, res) => {
  const { all } = getDB();
  const departments = await all(`
    SELECT d.*, 
           (SELECT COUNT(*) FROM complaints c WHERE c.department_id = d.id) as total_complaints,
           (SELECT COUNT(*) FROM complaints c WHERE c.department_id = d.id AND c.status = 'pending') as pending_complaints
    FROM departments d
    ORDER BY d.id
  `);
  res.json({ departments });
});

router.get('/complaint-types', async (req, res) => {
  const { all } = getDB();
  const { department_id } = req.query;
  
  let sql = `
    SELECT ct.*, d.name as department_name, d.code as department_code
    FROM complaint_types ct
    JOIN departments d ON ct.department_id = d.id
  `;
  let params = [];
  
  if (department_id) {
    sql += ' WHERE ct.department_id = ?';
    params.push(department_id);
  }
  
  sql += ' ORDER BY ct.id';
  
  const types = await all(sql, params);
  res.json({ types });
});

router.get('/areas', async (req, res) => {
  const { all } = getDB();
  const { level, parent_id } = req.query;
  
  let sql = 'SELECT * FROM areas WHERE 1=1';
  let params = [];
  
  if (level) {
    sql += ' AND level = ?';
    params.push(level);
  }
  
  if (parent_id) {
    sql += ' AND parent_id = ?';
    params.push(parent_id);
  }
  
  sql += ' ORDER BY id';
  
  const areas = await all(sql, params);
  res.json({ areas });
});

router.get('/areas/tree', async (req, res) => {
  const { all } = getDB();
  const areas = await all('SELECT * FROM areas ORDER BY level, parent_id, id');
  
  const buildTree = (parentId = null) => {
    return areas
      .filter(a => a.parent_id === parentId)
      .map(a => ({
        ...a,
        children: buildTree(a.id)
      }));
  };
  
  res.json({ areas: buildTree(null) });
});

router.get('/routing-map', async (req, res) => {
  const map = await getTypeDepartmentMap();
  res.json({ map });
});

router.get('/hotspots', async (req, res) => {
  const hotspots = await getActiveHotspots();
  res.json({ hotspots });
});

router.get('/stats/public', async (req, res) => {
  const { get, all } = getDB();
  
  const totalComplaints = (await get('SELECT COUNT(*) as count FROM complaints')).count;
  const resolvedComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'resolved'")).count;
  const processingComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status IN ('assigned', 'processing')")).count;
  const pendingComplaints = (await get("SELECT COUNT(*) as count FROM complaints WHERE status = 'pending'")).count;
  
  const avgRatingResult = await get('SELECT AVG(rating) as avg FROM reviews WHERE rating > 0');
  const avgRating = avgRatingResult.avg || 0;
  
  const deptStats = await all(`
    SELECT d.id, d.name, d.code,
           COUNT(c.id) as total,
           SUM(CASE WHEN c.status = 'resolved' THEN 1 ELSE 0 END) as resolved,
           SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN c.status = 'processing' OR c.status = 'assigned' THEN 1 ELSE 0 END) as processing,
           AVG(r.rating) as avg_rating,
           AVG(CASE WHEN c.status = 'resolved' 
                    THEN julianday(c.updated_at) - julianday(c.created_at) 
                    ELSE NULL END) as avg_resolve_days
    FROM departments d
    LEFT JOIN complaints c ON d.id = c.department_id
    LEFT JOIN reviews r ON c.id = r.complaint_id
    GROUP BY d.id
    ORDER BY resolved DESC
  `);
  
  const typeStats = await all(`
    SELECT ct.id, ct.name, COUNT(c.id) as count
    FROM complaint_types ct
    LEFT JOIN complaints c ON ct.id = c.type_id
    GROUP BY ct.id
    ORDER BY count DESC
    LIMIT 10
  `);
  
  const areaStats = await all(`
    SELECT a.id, a.name, COUNT(c.id) as count
    FROM areas a
    LEFT JOIN complaints c ON a.id = c.area_id
    WHERE a.level = 1
    GROUP BY a.id
    ORDER BY count DESC
  `);
  
  res.json({
    overview: {
      total: totalComplaints,
      resolved: resolvedComplaints,
      processing: processingComplaints,
      pending: pendingComplaints,
      avgRating: Number(avgRating.toFixed(1)),
      resolutionRate: totalComplaints > 0 ? Number(((resolvedComplaints / totalComplaints) * 100).toFixed(1)) : 0
    },
    departments: deptStats.map(d => ({
      ...d,
      avg_rating: d.avg_rating ? Number(d.avg_rating.toFixed(1)) : 0,
      avg_resolve_days: d.avg_resolve_days ? Number(d.avg_resolve_days.toFixed(1)) : 0,
      resolution_rate: d.total > 0 ? Number(((d.resolved / d.total) * 100).toFixed(1)) : 0
    })),
    types: typeStats,
    areas: areaStats
  });
});

module.exports = router;
