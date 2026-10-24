<script setup lang="ts">
import type { Developer } from '~~/shared/types'

const toast = useToast()
const { data, refresh, status } = await useFetch<{ developers: Developer[] }>(
  '/api/admin/developers',
  { server: false },
)
const empty = () => ({
  name: '',
  role: '',
  avatar: '',
  intro: '',
  cover: '',
  body: '',
  links: [] as { label: string; url: string }[],
})
const form = reactive(empty())
const slug = ref('')
const editing = ref<string | undefined>(undefined)
const saving = ref(false)
const confirmingDelete = ref('')
const deletingSlug = ref('')
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function showError(error: unknown, fallback: string) {
  const e = error as { data?: { error?: string } }
  toast.add({ title: e.data?.error ?? fallback, color: 'error' })
}

function create() {
  Object.assign(form, empty())
  slug.value = ''
  editing.value = ''
}
function edit(dev: Developer) {
  Object.assign(form, {
    name: dev.name,
    role: dev.role,
    avatar: dev.avatar,
    intro: dev.intro,
    cover: dev.cover ?? '',
    body: dev.body ?? '',
    links: (dev.links ?? []).map((link) => ({ ...link })),
  })
  slug.value = dev.slug
  editing.value = dev.slug
}

async function save() {
  const value = slug.value.trim().toLowerCase()
  if (!slugPattern.test(value) || !form.name.trim()) {
    toast.add({ title: 'slug 格式或名称无效', color: 'error' })
    return
  }
  if (form.links.some((link) => !link.label.trim() || !link.url.trim().startsWith('https://'))) {
    toast.add({ title: '每条链接都需要名称和 HTTPS 地址', color: 'error' })
    return
  }
  saving.value = true
  try {
    await $fetch(`/api/admin/developers/${value}`, {
      method: 'PUT',
      body: {
        name: form.name.trim(),
        role: form.role.trim(),
        avatar: form.avatar.trim(),
        intro: form.intro.trim(),
        ...(form.cover.trim() ? { cover: form.cover.trim() } : {}),
        ...(form.body.trim() ? { body: form.body.trim() } : {}),
        links: form.links.map((link) => ({ label: link.label.trim(), url: link.url.trim() })),
      },
    })
    editing.value = undefined
    await refresh()
    toast.add({ title: '已保存', color: 'success' })
  } catch (error) {
    showError(error, '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(value: string) {
  if (confirmingDelete.value !== value) {
    confirmingDelete.value = value
    return
  }
  confirmingDelete.value = ''
  deletingSlug.value = value
  try {
    await $fetch(`/api/admin/developers/${value}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: '已删除', color: 'success' })
  } catch (error) {
    showError(error, '删除失败')
  } finally {
    deletingSlug.value = ''
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <span class="text-sm text-(--ui-text-dimmed)">共 {{ data?.developers?.length ?? 0 }} 位</span
      ><UButton size="sm" @click="create">新建开发者资料</UButton>
    </div>
    <div
      v-if="editing !== undefined"
      class="mb-6 space-y-3 rounded-(--ui-radius) border border-(--ui-border) p-4"
    >
      <p class="font-medium">{{ editing ? '编辑开发者资料' : '新建开发者资料' }}</p>
      <UInput v-model="slug" :disabled="!!editing" placeholder="slug（小写字母、数字、连字符）" />
      <UInput v-model="form.name" placeholder="名称（必填）" /><UInput
        v-model="form.role"
        placeholder="角色描述"
      /><UInput v-model="form.avatar" placeholder="头像地址（可选）" />
      <UTextarea v-model="form.intro" :rows="2" placeholder="简介" /><UInput
        v-model="form.cover"
        placeholder="封面地址（可选）"
      /><UTextarea v-model="form.body" :rows="5" placeholder="正文（可选）" />
      <div class="space-y-2">
        <p class="text-xs text-(--ui-text-dimmed)">外部链接（最多 12 条）</p>
        <div v-for="(link, index) in form.links" :key="index" class="flex gap-2">
          <UInput v-model="link.label" placeholder="名称" /><UInput
            v-model="link.url"
            placeholder="https://…"
            class="flex-1"
          /><UButton size="xs" variant="ghost" color="error" @click="form.links.splice(index, 1)"
            >移除</UButton
          >
        </div>
        <UButton
          size="xs"
          variant="ghost"
          :disabled="form.links.length >= 12"
          @click="form.links.push({ label: '', url: '' })"
          >添加链接</UButton
        >
      </div>
      <div class="flex gap-2">
        <UButton size="sm" :loading="saving" @click="save">保存</UButton
        ><UButton size="sm" variant="ghost" @click="editing = undefined">取消</UButton>
      </div>
    </div>
    <p v-if="status === 'pending'" class="text-sm text-(--ui-text-dimmed)">加载中…</p>
    <p v-else-if="!data?.developers?.length" class="text-sm text-(--ui-text-dimmed)">
      还没有开发者资料。
    </p>
    <div v-else class="space-y-3">
      <article
        v-for="dev in data.developers"
        :key="dev.slug"
        class="flex items-center gap-3 rounded-(--ui-radius) border border-(--ui-border) p-4"
      >
        <img
          v-if="dev.avatar"
          :src="dev.avatar"
          alt=""
          class="h-10 w-10 rounded-full object-cover"
        />
        <div class="min-w-0 flex-1">
          <p class="font-medium">
            {{ dev.name }}
            <span class="text-xs text-(--ui-text-dimmed)">{{ dev.slug }} · {{ dev.role }}</span>
          </p>
          <p class="truncate text-sm text-(--ui-text-muted)">{{ dev.intro }}</p>
        </div>
        <div class="flex gap-2">
          <UButton size="xs" variant="ghost" @click="edit(dev)">编辑</UButton
          ><UButton
            size="xs"
            variant="ghost"
            color="error"
            :loading="deletingSlug === dev.slug"
            :disabled="!!deletingSlug && deletingSlug !== dev.slug"
            @click="remove(dev.slug)"
            >{{ confirmingDelete === dev.slug ? '确认删除？' : '删除' }}</UButton
          >
        </div>
      </article>
    </div>
  </div>
</template>
