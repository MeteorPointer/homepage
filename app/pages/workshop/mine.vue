<script setup lang="ts">
useHead({ title: '我的投稿 · NSUK' })

const { user, configured, login } = useAuth()
const { data } = await useFetch<{
  items: { id: string; title: string; category: string; status: string; reviewReason: string; createdAt: string }[]
}>('/api/workshop/mine/list', { server: false, immediate: !!user.value })

const labels: Record<string, string> = { pending: '待审核', published: '已发布', rejected: '已驳回' }
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-12">
    <div class="flex items-center justify-between"><h1 class="text-2xl font-bold">我的投稿</h1><UButton to="/workshop/submit" size="sm" variant="subtle">新投稿</UButton></div>
    <div v-if="!user" class="mt-8 rounded-(--ui-radius) border border-dashed border-(--ui-border) p-8 text-center">
      <p class="text-sm text-(--ui-text-muted)">登录后可查看投稿进度与审核意见。</p><UButton v-if="configured" class="mt-4" @click="login('/workshop/mine')">登录</UButton>
    </div>
    <div v-else-if="data?.items?.length" class="mt-8 space-y-3">
      <NuxtLink v-for="item in data.items" :key="item.id" :to="`/workshop/${item.id}`" class="block rounded-(--ui-radius) border border-(--ui-border) p-4 transition-colors hover:border-(--ui-border-accented)">
        <div class="flex items-center gap-2"><UBadge size="sm" variant="subtle">{{ labels[item.status] ?? item.status }}</UBadge><span class="font-medium">{{ item.title }}</span><span class="text-xs text-(--ui-text-dimmed)">{{ item.category }}</span></div>
        <p v-if="item.reviewReason" class="mt-2 text-sm text-(--ui-text-muted)">审核意见：{{ item.reviewReason }}</p>
      </NuxtLink>
    </div>
    <div v-else-if="user" class="mt-8 rounded-(--ui-radius) border border-dashed border-(--ui-border) p-8 text-center"><p class="text-sm text-(--ui-text-dimmed)">你还没有投稿。</p><UButton to="/workshop/submit" size="sm" variant="subtle" class="mt-4">去投稿</UButton></div>
  </div>
</template>
