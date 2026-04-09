import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

import LoginView from '../views/LoginView.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true, noSidebar: true },
  },
  {
    path: '/apply',
    name: 'apply',
    component: () => import('../views/ApplyView.vue'),
    meta: { public: true, noSidebar: true },
  },
  {
    path: '/invest',
    name: 'invest',
    component: () => import('../views/InvestorApplyView.vue'),
    meta: { public: true, noSidebar: true },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/jobs/new',
    name: 'new-job',
    component: () => import('../views/NewJobView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/tracking',
    name: 'tracking',
    component: () => import('../views/TrackingView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/expenses',
    name: 'expenses',
    component: () => import('../views/ExpensesView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/invoices',
    name: 'invoices',
    component: () => import('../views/InvoicesView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/messages',
    name: 'messages',
    component: () => import('../views/MessagesView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/notifications',
    name: 'notifications',
    component: () => import('../views/NotificationsView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/data',
    name: 'data-manager',
    component: () => import('../views/DataManagerView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/driver',
    name: 'driver',
    component: () => import('../views/DriverView.vue'),
    meta: { roles: ['Driver', 'Super Admin'], noSidebar: true },
  },
  {
    path: '/investor',
    name: 'investor',
    component: () => import('../views/InvestorView.vue'),
    meta: { roles: ['Super Admin', 'Investor'] },
  },
  {
    path: '/users',
    name: 'users',
    component: () => import('../views/UsersView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/trucks',
    name: 'trucks',
    component: () => import('../views/TrucksView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher', 'Investor'] },
  },
  {
    path: '/investors',
    name: 'investors',
    component: () => import('../views/InvestorsView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/drivers',
    name: 'drivers-db',
    component: () => import('../views/DriversDbView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/trailers',
    name: 'trailers',
    component: () => import('../views/TrailersView.vue'),
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/applications',
    name: 'applications',
    component: () => import('../views/ApplicationsView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/investor-applications',
    name: 'investor-applications',
    component: () => import('../views/InvestorApplicationsView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/admin/tools',
    name: 'admin-tools',
    component: () => import('../views/AdminToolsView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/archive',
    name: 'archive',
    component: () => import('../views/ArchiveView.vue'),
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/',
    redirect: '/login',
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()

  if (auth.isLoading) {
    await auth.checkSession()
  }

  // Public pages
  if (to.meta.public) {
    if (auth.isAuthenticated) return { path: auth.roleHome }
    return true
  }

  // Not authenticated
  if (!auth.isAuthenticated) {
    return { name: 'login' }
  }

  // Role check
  if (to.meta.roles && !to.meta.roles.includes(auth.user.role)) {
    return { path: auth.roleHome }
  }

  return true
})

export default router
