const { getDB } = require('../database');

const HOTSPOT_THRESHOLD = 3;
const HOTSPOT_WINDOW_DAYS = 7;

async function updateHotspots(typeId, areaId) {
  const { run, get } = getDB();
  const area = await get('SELECT parent_id, level FROM areas WHERE id = ?', [areaId]);
  
  const areaIdsToCheck = [areaId];
  if (area && area.parent_id) {
    areaIdsToCheck.push(area.parent_id);
  }

  for (const aid of areaIdsToCheck) {
    const countResult = await get(`
      SELECT COUNT(*) as count FROM complaints
      WHERE type_id = ? AND area_id = ?
      AND created_at >= datetime('now', '-${HOTSPOT_WINDOW_DAYS} days')
      AND status != 'cancelled'
    `, [typeId, aid]);
    const count = countResult.count;

    const existing = await get(`
      SELECT id FROM hotspots WHERE type_id = ? AND area_id = ? AND is_active = 1
    `, [typeId, aid]);

    if (count >= HOTSPOT_THRESHOLD) {
      if (existing) {
        await run(`
          UPDATE hotspots 
          SET complaint_count = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `, [count, existing.id]);
      } else {
        await run(`
          INSERT INTO hotspots (type_id, area_id, complaint_count, is_active)
          VALUES (?, ?, ?, 1)
        `, [typeId, aid, count]);
      }
    } else if (existing) {
      await run(`
        UPDATE hotspots SET is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `, [existing.id]);
    }
  }
}

async function getActiveHotspots() {
  const { all } = getDB();
  return await all(`
    SELECT h.*, ct.name as type_name, a.name as area_name,
           (SELECT GROUP_CONCAT(c.id) FROM complaints c
            WHERE c.type_id = h.type_id AND c.area_id = h.area_id
            AND c.created_at >= datetime('now', '-${HOTSPOT_WINDOW_DAYS} days')
            AND c.status != 'cancelled') as complaint_ids
    FROM hotspots h
    JOIN complaint_types ct ON h.type_id = ct.id
    JOIN areas a ON h.area_id = a.id
    WHERE h.is_active = 1
    ORDER BY h.complaint_count DESC
  `);
}

async function scanAndUpdateHotspots() {
  const { all } = getDB();
  const types = await all('SELECT id FROM complaint_types');
  const areas = await all('SELECT id FROM areas');

  for (const type of types) {
    for (const area of areas) {
      await updateHotspots(type.id, area.id);
    }
  }

  console.log('热点问题扫描完成');
}

module.exports = {
  updateHotspots,
  getActiveHotspots,
  scanAndUpdateHotspots,
  HOTSPOT_THRESHOLD,
  HOTSPOT_WINDOW_DAYS
};
