const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function removeToken() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

function getUser() {
  const userStr = localStorage.getItem('user');
  return userStr ? JSON.parse(userStr) : null;
}

function setUser(user) {
  localStorage.setItem('user', JSON.stringify(user));
}

async function apiRequest(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }

  return data;
}

const api = {
  auth: {
    register: (data) => apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
    login: (data) => apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data)
    }),
    me: () => apiRequest('/auth/me'),
    logout: () => apiRequest('/auth/logout', { method: 'POST' })
  },

  common: {
    getDepartments: () => apiRequest('/common/departments'),
    getComplaintTypes: (departmentId) => apiRequest(`/common/complaint-types${departmentId ? `?department_id=${departmentId}` : ''}`),
    getAreas: (level, parentId) => {
      let url = '/common/areas';
      const params = [];
      if (level) params.push(`level=${level}`);
      if (parentId) params.push(`parent_id=${parentId}`);
      if (params.length) url += '?' + params.join('&');
      return apiRequest(url);
    },
    getAreasTree: () => apiRequest('/common/areas/tree'),
    getHotspots: () => apiRequest('/common/hotspots'),
    getPublicStats: () => apiRequest('/common/stats/public')
  },

  complaints: {
    create: (formData) => apiRequest('/complaints', {
      method: 'POST',
      body: formData,
      headers: {}
    }),
    analyze: (description) => apiRequest('/complaints/analyze', {
      method: 'POST',
      body: JSON.stringify({ description })
    }),
    list: (params = {}) => {
      const query = new URLSearchParams(params).toString();
      return apiRequest(`/complaints${query ? '?' + query : ''}`);
    },
    get: (id) => apiRequest(`/complaints/${id}`),
    claim: (id) => apiRequest(`/complaints/${id}/claim`, { method: 'POST' }),
    process: (id, remark) => apiRequest(`/complaints/${id}/process`, {
      method: 'POST',
      body: JSON.stringify({ remark })
    }),
    complete: (id, result) => apiRequest(`/complaints/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify({ result })
    }),
    review: (id, rating, content) => apiRequest(`/complaints/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ rating, content })
    }),
    requestReview: (id, reason) => apiRequest(`/complaints/${id}/request-review`, {
      method: 'POST',
      body: JSON.stringify({ reason })
    }),
    cancel: (id) => apiRequest(`/complaints/${id}/cancel`, { method: 'POST' })
  },

  notifications: {
    list: (params = {}) => {
      const query = new URLSearchParams(params).toString();
      return apiRequest(`/notifications${query ? '?' + query : ''}`);
    },
    getUnreadCount: () => apiRequest('/notifications/unread-count'),
    markRead: (id) => apiRequest(`/notifications/${id}/read`, { method: 'POST' }),
    markAllRead: () => apiRequest('/notifications/read-all', { method: 'POST' })
  },

  admin: {
    getStats: () => apiRequest('/admin/stats'),
    getComplaints: (params = {}) => {
      const query = new URLSearchParams(params).toString();
      return apiRequest(`/admin/complaints${query ? '?' + query : ''}`);
    },
    getOverdue: () => apiRequest('/admin/overdue'),
    getUrgent: () => apiRequest('/admin/urgent'),
    scanOverdue: () => apiRequest('/admin/scan-overdue', { method: 'POST' }),
    scanHotspots: () => apiRequest('/admin/scan-hotspots', { method: 'POST' }),
    extendDeadline: (id, days, reason) => apiRequest(`/admin/complaints/${id}/extend-deadline`, {
      method: 'POST',
      body: JSON.stringify({ days, reason })
    }),
    assignStaff: (id, staffId) => apiRequest(`/admin/complaints/${id}/assign`, {
      method: 'POST',
      body: JSON.stringify({ staff_id: staffId })
    }),
    transferDepartment: (id, departmentId, reason) => apiRequest(`/admin/complaints/${id}/transfer`, {
      method: 'POST',
      body: JSON.stringify({ department_id: departmentId, reason })
    }),
    getDepartmentStats: () => apiRequest('/admin/departments/stats'),
    getUsers: (params = {}) => {
      const query = new URLSearchParams(params).toString();
      return apiRequest(`/admin/users${query ? '?' + query : ''}`);
    }
  }
};

function getStatusText(status) {
  const map = {
    'pending': '待处理',
    'assigned': '已分派',
    'processing': '处理中',
    'resolved': '已完成',
    'reviewing': '复查中',
    'cancelled': '已取消'
  };
  return map[status] || status;
}

function getStatusBadge(status) {
  const map = {
    'pending': 'badge-pending',
    'assigned': 'badge-assigned',
    'processing': 'badge-processing',
    'resolved': 'badge-resolved',
    'reviewing': 'badge-reviewing',
    'cancelled': 'badge-cancelled'
  };
  return map[status] || 'badge-normal';
}

function getUrgencyText(urgency) {
  return urgency === 'urgent' ? '紧急' : '普通';
}

function getUrgencyBadge(urgency) {
  return urgency === 'urgent' ? 'badge-urgent' : 'badge-normal';
}

function getActionText(action) {
  const map = {
    'create': '提交诉求',
    'claim': '认领工单',
    'process': '更新进度',
    'complete': '完成处理',
    'review': '用户评价',
    'request_review': '申请复查',
    'cancel': '撤销诉求',
    'admin_assign': '管理员分派',
    'transfer': '转派部门',
    'extend_deadline': '延期处理',
    'overdue_warning': '逾期提醒'
  };
  return map[action] || action;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const date = new Date(dateStr);
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function showAlert(message, type = 'success') {
  const alertId = 'alert-' + Date.now();
  const alertHtml = `
    <div id="${alertId}" class="alert alert-${type}">
      <span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
      <span>${message}</span>
    </div>
  `;
  
  const container = document.querySelector('.content-area') || document.body;
  container.insertAdjacentHTML('afterbegin', alertHtml);
  
  setTimeout(() => {
    const alert = document.getElementById(alertId);
    if (alert) {
      alert.style.opacity = '0';
      alert.style.transform = 'translateY(-10px)';
      alert.style.transition = 'all 0.3s ease';
      setTimeout(() => alert.remove(), 300);
    }
  }, 3000);
}

function showModal(contentHtml, title = '提示') {
  const modalId = 'modal-' + Date.now();
  const modalHtml = `
    <div id="${modalId}" class="modal show">
      <div class="modal-content">
        <div class="modal-header">
          <h3 class="modal-title">${title}</h3>
          <button class="modal-close" onclick="closeModal('${modalId}')">&times;</button>
        </div>
        <div class="modal-body">
          ${contentHtml}
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  
  document.getElementById(modalId).addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
      closeModal(modalId);
    }
  });
  
  return modalId;
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.remove();
  }
}

function showLoading(container) {
  container = container || document.querySelector('.content-area');
  container.innerHTML = '<div style="text-align:center;padding:100px;"><div class="loading"></div><p style="margin-top:16px;color:#666;">加载中...</p></div>';
}

function logout() {
  removeToken();
  window.location.href = '/';
}
