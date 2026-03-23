/* ============================================================
   LAYOUT.JS — Shared sidebar, auth, and helpers
   ============================================================ */

const Layout = {
  user: null,
  _options: {},

  // ---- Nav config per role ----
  _navItems: {
    Admin: [
      { href: '/dashboard.html', icon: '&#9635;', label: 'Dashboard', page: 'dashboard' },
      { href: '/driver.html', icon: '&#128666;', label: 'Driver App', page: 'driver' },
      { href: '/investor.html', icon: '&#128200;', label: 'Investor View', page: 'investor' },
      { href: '/users.html', icon: '&#9881;', label: 'User Management', page: 'users' },
      { href: '/index.html', icon: '&#9776;', label: 'Data Manager', page: 'data' },
    ],
    Dispatcher: [
      { href: '/dashboard.html', icon: '&#9635;', label: 'Dashboard', page: 'dashboard' },
      { href: '/index.html', icon: '&#9776;', label: 'Data Manager', page: 'data' },
    ],
    Investor: [
      { href: '/investor.html', icon: '&#128200;', label: 'Financial Overview', page: 'investor' },
    ],
    Driver: [],
  },

  // ---- Role-based redirect targets ----
  _roleHome: {
    Admin: '/dashboard.html',
    Dispatcher: '/dashboard.html',
    Driver: '/driver.html',
    Investor: '/investor.html',
  },

  // ---- Main init ----
  async init(options = {}) {
    this._options = options;
    const { page, requiredRoles, publicPage, noSidebar, onReady } = options;

    // Socket.IO live reload + status
    if (typeof io !== 'undefined') {
      try {
        const sock = io();
        sock.on('reload', () => location.reload());
        sock.on('connect', () => setSidebarStatus('ok', 'Connected'));
        sock.on('disconnect', () => setSidebarStatus('error', 'Disconnected'));
      } catch {}
    }

    // Auth check
    try {
      const res = await fetch('/api/auth/session');
      const data = await res.json();

      if (!data.authenticated) {
        if (!publicPage) { window.location.href = '/login.html'; return; }
        if (noSidebar) document.body.classList.add('no-sidebar');
        if (onReady) onReady(null);
        return;
      }

      this.user = data.user;

      // Role gate
      if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(data.user.role)) {
        window.location.href = this._roleHome[data.user.role] || '/login.html';
        return;
      }

      // Render sidebar
      if (!noSidebar) {
        this._renderSidebar(page);
      } else {
        document.body.classList.add('no-sidebar');
      }

      window._userRole = data.user.role;
      if (onReady) onReady(data.user);

    } catch {
      if (!publicPage) { window.location.href = '/login.html'; return; }
      if (noSidebar) document.body.classList.add('no-sidebar');
      if (onReady) onReady(null);
    }
  },

  // ---- Render sidebar (called by init or manually) ----
  _renderSidebar(activePage) {
    const role = this.user ? this.user.role : 'Admin';
    const items = this._navItems[role] || [];

    // Remove existing sidebar if any
    const existing = document.getElementById('app-sidebar');
    if (existing) existing.remove();

    const sidebar = document.createElement('aside');
    sidebar.className = 'sidebar';
    sidebar.id = 'app-sidebar';
    sidebar.innerHTML = `
      <div class="sidebar-header">
        <h1><span class="icon">&#11044;</span> Dispatch</h1>
        <p class="subtitle">Logistics Management</p>
      </div>
      <div class="sidebar-section">
        ${items.map(item =>
          `<a href="${item.href}" class="nav-item${item.page === activePage ? ' active' : ''}">
            <span class="nav-icon">${item.icon}</span> ${item.label}
          </a>`
        ).join('')}
        <div id="sidebarExtra"></div>
      </div>
      <div class="sidebar-footer">
        <a href="#" class="nav-item" onclick="Layout.logout();return false;" style="color:var(--danger);margin-bottom:0.5rem;">
          <span class="nav-icon">&#10140;</span> Logout
        </a>
        <div class="status-dot" id="sidebarStatus">
          <span class="dot"></span> Connecting...
        </div>
      </div>
    `;

    document.body.insertBefore(sidebar, document.body.firstChild);
    document.body.classList.remove('no-sidebar');
  },

  // ---- Show sidebar (for pages that start without one, like login.html) ----
  showSidebar(activePage) {
    this._renderSidebar(activePage || this._options.page);
  },

  // ---- Logout ----
  async logout() {
    try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
    window.location.href = '/login.html';
  },
};

/* ============================================================
   GLOBAL HELPERS
   ============================================================ */

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function toast(msg, type = 'success') {
  // Ensure toast container exists
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    container.innerHTML = '<div class="toast" id="toast"></div>';
    document.body.appendChild(container);
  }
  const t = container.querySelector('.toast') || document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

function setSidebarStatus(type, text) {
  const el = document.getElementById('sidebarStatus');
  if (el) el.innerHTML = `<span class="dot ${type}"></span> ${escapeHtml(text)}`;
}

function toggleGroup(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('collapsed');
}
