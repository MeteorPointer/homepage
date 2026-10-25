<script setup lang="ts">
useHead({ title: '后台 · NSUK' })

const { user } = useAuth()

function hasPerm(cap: string) {
  const permissions = user.value?.permissions ?? []
  return permissions.includes('*') || permissions.includes(cap)
}

const allTabs = [
  { key: 'feedback', label: '反馈', cap: 'feedback.manage' },
  { key: 'workshop', label: '工坊审核', cap: 'workshop.review' },
  { key: 'mods', label: '特色模组', cap: 'mods.manage' },
  { key: 'developers', label: '开发者资料', cap: 'developers.manage' },
  { key: 'changelog', label: '更新日志', cap: 'changelog.manage' },
  { key: 'config', label: '站点设置', cap: 'site.configure' },
  { key: 'users', label: '用户', cap: 'audit.view' },
  { key: 'audit', label: '审计', cap: 'audit.view' },
]
const tabs = computed(() => allTabs.filter((tab) => hasPerm(tab.cap)))
const allowed = computed(() => tabs.value.length > 0)
const canViewStats = computed(() => hasPerm('audit.view'))

const { data: stats } = await useFetch<{
  stats: { pendingWorkshop: number; openFeedback: number; users: number; licenseTtlHours: number }
}>('/api/admin/stats', { server: false, immediate: canViewStats.value })

const active = ref(tabs.value[0]?.key ?? '')
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-12">
    <h1 class="text-2xl font-bold">后台</h1>

    <div
      v-if="!user || !allowed"
      class="mt-8 rounded-(--ui-radius) border border-dashed border-(--ui-border) p-8 text-sm text-(--ui-text-dimmed)"
    >
      需要后台权限。若你刚获得权限，请重新登录后再试。
    </div>

    <template v-else>
      <div v-if="canViewStats" class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-(--ui-radius) border border-(--ui-border) p-4">
          <p class="text-xs text-(--ui-text-dimmed)">待审作品</p>
          <p class="mt-1 text-2xl font-semibold">{{ stats?.stats.pendingWorkshop ?? '—' }}</p>
        </div>
        <div class="rounded-(--ui-radius) border border-(--ui-border) p-4">
          <p class="text-xs text-(--ui-text-dimmed)">待处理反馈</p>
          <p class="mt-1 text-2xl font-semibold">{{ stats?.stats.openFeedback ?? '—' }}</p>
        </div>
        <div class="rounded-(--ui-radius) border border-(--ui-border) p-4">
          <p class="text-xs text-(--ui-text-dimmed)">注册用户</p>
          <p class="mt-1 text-2xl font-semibold">{{ stats?.stats.users ?? '—' }}</p>
        </div>
        <div class="rounded-(--ui-radius) border border-(--ui-border) p-4">
          <p class="text-xs text-(--ui-text-dimmed)">License 有效期</p>
          <p class="mt-1 text-2xl font-semibold">{{ stats?.stats.licenseTtlHours ?? '—' }}h</p>
        </div>
      </div>

      <nav class="mt-8 flex gap-2 border-b border-(--ui-border)">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="border-b-2 px-3 py-2 text-sm transition-colors"
          :class="
            active === t.key
              ? 'border-(--ui-primary) text-(--ui-text-highlighted)'
              : 'border-transparent text-(--ui-text-muted)'
          "
          @click="active = t.key"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="mt-6">
        <AdminFeedbackTab v-if="active === 'feedback'" />
        <AdminWorkshopTab v-else-if="active === 'workshop'" />
        <AdminModsTab v-else-if="active === 'mods'" />
        <AdminDevelopersTab v-else-if="active === 'developers'" />
        <AdminChangelogTab v-else-if="active === 'changelog'" />
        <AdminConfigTab v-else-if="active === 'config'" />
        <AdminUsersTab v-else-if="active === 'users'" />
        <AdminAuditTab v-else-if="active === 'audit'" />
      </div>
    </template>
  </div>
</template>
