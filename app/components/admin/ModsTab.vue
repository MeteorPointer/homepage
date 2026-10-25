<script setup lang="ts">
import type { ExternalMod } from '~~/shared/types'

const toast = useToast()
const { data, refresh, status } = await useFetch<{ mods: ExternalMod[] }>(
  '/api/admin/external-mods',
  { server: false },
)

const empty = () => ({ name: '', description: '', url: '', author: '', icon: '' })
const form = reactive(empty())
const editing = ref<string | null | undefined>(undefined)
const saving = ref(false)
const confirmingDelete = ref('')
const deletingId = ref('')

function showError(error: unknown, fallback: string) {
  const e = error as { data?: { error?: string } }
  toast.add({ title: e.data?.error ?? fallback, color: 'error' })
}

function create() {
  Object.assign(form, empty())
  editing.value = null
}

function edit(mod: ExternalMod) {
  Object.assign(form, {
    name: mod.name,
    description: mod.description,
    url: mod.url,
    author: mod.author ?? '',
    icon: mod.icon ?? '',
  })
  editing.value = mod.id
}

async function save() {
  if (!form.name.trim() || !form.url.trim().startsWith('https://')) {
    toast.add({ title: '名称必填，链接必须为 HTTPS 地址', color: 'error' })
    return
  }
  saving.value = true
  const body = {
    name: form.name.trim(),
    description: form.description.trim(),
    url: form.url.trim(),
    ...(form.author.trim() ? { author: form.author.trim() } : {}),
    ...(form.icon.trim() ? { icon: form.icon.trim() } : {}),
  }
  try {
    if (editing.value)
      await $fetch(`/api/admin/external-mods/${editing.value}`, { method: 'PUT', body })
    else await $fetch('/api/admin/external-mods', { method: 'POST', body })
    editing.value = undefined
    await refresh()
    toast.add({ title: '已保存', color: 'success' })
  } catch (error) {
    showError(error, '保存失败')
  } finally {
    saving.value = false
  }
}

async function remove(id: string) {
  if (confirmingDelete.value !== id) {
    confirmingDelete.value = id
    return
  }
  confirmingDelete.value = ''
  deletingId.value = id
  try {
    await $fetch(`/api/admin/external-mods/${id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: '已删除', color: 'success' })
  } catch (error) {
    showError(error, '删除失败')
  } finally {
    deletingId.value = ''
  }
}
</script>

<template>
  <div>
    <div class="mb-4 flex items-center justify-between">
      <span class="text-sm text-(--ui-text-dimmed)">共 {{ data?.mods?.length ?? 0 }} 个</span
      ><UButton size="sm" @click="create">新建特色模组</UButton>
    </div>
    <div
      v-if="editing !== undefined"
      class="mb-6 space-y-3 rounded-(--ui-radius) border border-(--ui-border) p-4"
    >
      <p class="font-medium">{{ editing ? '编辑特色模组' : '新建特色模组' }}</p>
      <UInput v-model="form.name" placeholder="名称（必填）" />
      <UTextarea v-model="form.description" :rows="2" placeholder="简介" />
      <UInput v-model="form.url" placeholder="链接（https://…）" />
      <UInput v-model="form.author" placeholder="作者（可选）" />
      <UInput v-model="form.icon" placeholder="图标（可选）" />
      <div class="flex gap-2">
        <UButton size="sm" :loading="saving" @click="save">保存</UButton
        ><UButton size="sm" variant="ghost" @click="editing = undefined">取消</UButton>
      </div>
    </div>
    <p v-if="status === 'pending'" class="text-sm text-(--ui-text-dimmed)">加载中…</p>
    <p v-else-if="!data?.mods?.length" class="text-sm text-(--ui-text-dimmed)">还没有特色模组。</p>
    <div v-else class="space-y-3">
      <article
        v-for="mod in data.mods"
        :key="mod.id"
        class="flex items-center gap-3 rounded-(--ui-radius) border border-(--ui-border) p-4"
      >
        <img v-if="mod.icon" :src="mod.icon" alt="" class="h-10 w-10 rounded object-cover">
        <div class="min-w-0 flex-1">
          <p class="font-medium">
            {{ mod.name }}
            <span v-if="mod.author" class="text-xs text-(--ui-text-dimmed)">{{ mod.author }}</span>
          </p>
          <p class="truncate text-sm text-(--ui-text-muted)">{{ mod.description }}</p>
        </div>
        <div class="flex gap-2">
          <UButton size="xs" variant="ghost" @click="edit(mod)">编辑</UButton
          ><UButton
            size="xs"
            variant="ghost"
            color="error"
            :loading="deletingId === mod.id"
            :disabled="!!deletingId && deletingId !== mod.id"
            @click="remove(mod.id)"
            >{{ confirmingDelete === mod.id ? '确认删除？' : '删除' }}</UButton
          >
        </div>
      </article>
    </div>
  </div>
</template>
