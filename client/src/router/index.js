import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

import LoginView from '../views/LoginView.vue'
import DashboardView from '../views/DashboardView.vue'
import DataManagerView from '../views/DataManagerView.vue'
import DriverView from '../views/DriverView.vue'
import InvestorView from '../views/InvestorView.vue'
import UsersView from '../views/UsersView.vue'
import TrackingView from '../views/TrackingView.vue'
import ExpensesView from '../views/ExpensesView.vue'
import MessagesView from '../views/MessagesView.vue'
import NotificationsView from '../views/NotificationsView.vue'
import AdminToolsView from '../views/AdminToolsView.vue'
import TrucksView from '../views/TrucksView.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { public: true, noSidebar: true },
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: DashboardView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/tracking',
    name: 'tracking',
    component: TrackingView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/expenses',
    name: 'expenses',
    component: ExpensesView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/messages',
    name: 'messages',
    component: MessagesView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/notifications',
    name: 'notifications',
    component: NotificationsView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/data',
    name: 'data-manager',
    component: DataManagerView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/driver',
    name: 'driver',
    component: DriverView,
    meta: { roles: ['Driver', 'Super Admin'], noSidebar: true },
  },
  {
    path: '/investor',
    name: 'investor',
    component: InvestorView,
    meta: { roles: ['Super Admin', 'Investor'] },
  },
  {
    path: '/users',
    name: 'users',
    component: UsersView,
    meta: { roles: ['Super Admin'] },
  },
  {
    path: '/trucks',
    name: 'trucks',
    component: TrucksView,
    meta: { roles: ['Super Admin', 'Dispatcher'] },
  },
  {
    path: '/admin/tools',
    name: 'admin-tools',
    component: AdminToolsView,
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
