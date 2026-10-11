const API_BASE = '/api';

function getToken() {
  return localStorage.getItem('token');
}

function getUser() {
  const u = localStorage.getItem('user');
  return u ? JSON.parse(u) : null;
}

function saveAuth(token, user) {
  localStorage.setItem('token', token);
  localStorage.setItem('user', JSON.stringify(user));
}

function clearAuth() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
}

async function apiRequest(method, endpoint, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${endpoint}`, opts);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || 'Bilinməyən xəta.');
  }

  return data;
}

async function uploadImage(file) {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch(`${API_BASE}/exams/upload-image`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}` },
    body: formData
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Şəkil yüklənə bilmədi.');
  return data.path;
}

function showAlert(containerId, message, type = 'error') {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.textContent = message;
  el.className = `alert alert-${type} show`;
  setTimeout(() => el.classList.remove('show'), 5000);
}

function requireAuth() {
  const token = getToken();
  const user = getUser();
  if (!token || !user) {
    window.location.href = '/login';
    return null;
  }
  return user;
}

function requireRole(role) {
  const user = requireAuth();
  if (!user) return null;
  if (user.role !== role) {
    window.location.href = user.role === 'admin' ? '/admin' : '/user';
    return null;
  }
  return user;
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('az-AZ', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}