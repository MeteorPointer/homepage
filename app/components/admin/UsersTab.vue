<script setup lang="ts">
const query = ref('')
const { data, refresh } = await useFetch<{ items: { sub: string; username: string; displayName: string; roleKey: string; lastLoginAt: string | null; deleted: boolean }[] }>('/api/admin/users', { query: { q: query }, server: false })
watch(query, () => refresh())
</script>
<template><div><UInput v-model="query" placeholder="搜索用户名或显示名" class="mb-4 max-w-sm" /><div class="space-y-2"><div v-for="user in data?.items" :key="user.sub" class="rounded-(--ui-radius) border border-(--ui-border) p-3 text-sm"><strong>{{ user.displayName }}</strong> <span class="text-(--ui-text-dimmed)">@{{ user.username }} · {{ user.roleKey }}</span><span v-if="user.deleted" class="ml-2 text-(--ui-text-error)">已注销</span></div></div></div></template>
