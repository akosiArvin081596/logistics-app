import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

import LoginView from '../views/LoginView.vue'
import DashboardView from '../views/DashboardView.vue'
import DataManagerView from '../views/DataManagerView.vue'
import DriverView from '../views/DriverView.vue'
import InvestorView from '../views/InvestorView.vue'
import UsersView from '../views/UsersView.vue'

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
    meta: { roles: ['Admin', 'Dispatcher'] },
  },
  {
    path: '/data',
    name: 'data-manager',
    component: DataManagerView,
    meta: { roles: ['Admin', 'Dispatcher'] },
  },
  {
    path: '/driver',
    name: 'driver',
    component: DriverView,
    meta: { roles: ['Driver', 'Admin'], noSidebar: true },
  },
  {
    path: '/investor',
    name: 'investor',
    component: InvestorView,
    meta: { roles: ['Admin', 'Investor'] },
  },
  {
    path: '/users',
    name: 'users',
    component: UsersView,
    meta: { roles: ['Admin'] },
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
