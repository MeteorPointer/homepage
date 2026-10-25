<script setup lang="ts">
import type { WorkshopItemSummary } from '#shared/types'

useHead({ title: '创意工坊 · NSUK' })

const { data } = await useFetch<{
  items: WorkshopItemSummary[]
  total: number
}>('/api/workshop')
const { user } = useAuth()
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-12">
    <header class="mb-8 flex items-start justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold">创意工坊</h1>
        <p class="mt-2 text-sm text-(--ui-text-muted)">
          站内展示作品信息与截图；下载请使用作品页提供的站外链接。
        </p>
      </div>
      <div class="flex shrink-0 gap-2">
        <UButton v-if="user" to="/workshop/mine" variant="ghost">我的投稿</UButton>
        <UButton to="/workshop/submit" variant="subtle">投稿</UButton>
      </div>
    </header>

    <div v-if="data?.items?.length" class="grid gap-4 sm:grid-cols-2">
      <NuxtLink
        v-for="item in data.items"
        :key="item.id"
        :to="`/workshop/${item.id}`"
        class="rounded-(--ui-radius) border border-(--ui-border) p-5 transition-colors hover:border-(--ui-border-accented)"
      >
        <div class="flex items-center gap-2">
          <UBadge variant="subtle" size="sm">{{ item.category }}</UBadge>
          <span class="text-xs text-(--ui-text-dimmed)">{{ item.authorName }}</span>
        </div>
        <h2 class="mt-2 font-medium">{{ item.title }}</h2>
        <p class="mt-1 line-clamp-2 text-sm text-(--ui-text-muted)">{{ item.description }}</p>
      </NuxtLink>
    </div>

    <div
      v-else
      class="rounded-(--ui-radius) border border-dashed border-(--ui-border) px-6 py-10 text-center"
    >
      <p class="text-sm text-(--ui-text-dimmed)">还没有已发布的作品。</p>
      <UButton to="/workshop/submit" size="sm" variant="subtle" class="mt-4">成为第一位投稿者</UButton>
    </div>
  </div>
</template>
