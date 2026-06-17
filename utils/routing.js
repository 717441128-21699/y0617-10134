const { getDB } = require('../database');

async function routeComplaint(typeId) {
  const { get } = getDB();
  const type = await get(`
    SELECT ct.*, d.id as department_id, d.name as department_name
    FROM complaint_types ct
    JOIN departments d ON ct.department_id = d.id
    WHERE ct.id = ?
  `, [typeId]);

  if (!type) {
    throw new Error('诉求类型不存在');
  }

  return {
    departmentId: type.department_id,
    departmentName: type.department_name,
    typeId: type.id,
    typeName: type.name
  };
}

async function getTypeDepartmentMap() {
  const { all } = getDB();
  return await all(`
    SELECT ct.id, ct.name, ct.code, d.id as department_id, d.name as department_name
    FROM complaint_types ct
    JOIN departments d ON ct.department_id = d.id
    ORDER BY ct.id
  `);
}

async function getDepartmentTypes(departmentId) {
  const { all } = getDB();
  return await all(`
    SELECT ct.* FROM complaint_types ct
    WHERE ct.department_id = ?
    ORDER BY ct.name
  `, [departmentId]);
}

async function analyzeComplaintContent(description) {
  const { get } = getDB();
  const keywords = {
    '噪音': 'ZYRM',
    '施工': 'ZYRM',
    '扰民': 'ZYRM',
    '道路': 'DLPS',
    '路面': 'DLPS',
    '井盖': 'DLPS',
    '路灯': 'DLPS',
    '违章': 'WZJZ',
    '违建': 'WZJZ',
    '搭建': 'WZJZ',
    '污染': 'HJWR',
    '污水': 'HJWR',
    '垃圾': 'HJWR',
    '废气': 'HJWR',
    '拥堵': 'JTYS',
    '交通': 'JTYS',
    '市容': 'SRZL',
    '小广告': 'SRZL',
    '物业': 'WYJF',
    '小区': 'WYJF',
    '消费': 'XFJF',
    '商品': 'XFJF',
    '旅游': 'LYTS',
    '景区': 'LYTS',
    '医疗': 'YLWS',
    '医院': 'YLWS',
    '占道': 'ZDJY',
    '摊贩': 'ZDJY',
    '绿化': 'LHPH',
    '树木': 'LHPH'
  };

  let matchedType = null;
  let maxMatches = 0;

  Object.entries(keywords).forEach(([keyword, typeCode]) => {
    if (description.includes(keyword)) {
      const typeCount = (description.match(new RegExp(keyword, 'g')) || []).length;
      if (typeCount > maxMatches) {
        maxMatches = typeCount;
        matchedType = typeCode;
      }
    }
  });

  if (matchedType) {
    const type = await get('SELECT id, name, department_id FROM complaint_types WHERE code = ?', [matchedType]);
    if (type) {
      return {
        suggestedTypeId: type.id,
        suggestedTypeName: type.name,
        departmentId: type.department_id,
        confidence: Math.min(maxMatches * 20, 100)
      };
    }
  }

  return null;
}

module.exports = {
  routeComplaint,
  getTypeDepartmentMap,
  getDepartmentTypes,
  analyzeComplaintContent
};
