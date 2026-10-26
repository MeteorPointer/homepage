<script setup lang="ts">
interface OfficialBuild {
  id: string
  minecraftVersion: string
  modVersion: string
  artifactSha256: string
  enabled: boolean
  notes: string
  createdAt: string
}

const toast = useToast()
const { data, refresh, status } = await useFetch<{ builds: OfficialBuild[] }>(
  '/api/admin/mod-builds',
  { server: false },
)
const form = reactive({ minecraftVersion: '', modVersion: '', artifactSha256: '', notes: '' })
const saving = ref(false)
const updating = ref('')

function errorMessage(error: unknown, fallback: string) {
  return (error as { data?: { error?: string } }).data?.error ?? fallback
}

async function registerBuild() {
  saving.value = true
  try {
    await $fetch('/api/admin/mod-builds', {
      method: 'POST',
      body: {
        minecraftVersion: form.minecraftVersion.trim(),
        modVersion: form.modVersion.trim(),
        artifactSha256: form.artifactSha256.trim(),
        notes: form.notes.trim(),
      },
    })
    Object.assign(form, { minecraftVersion: '', modVersion: '', artifactSha256: '', notes: '' })
    await refresh()
    toast.add({ title: '官方构建已登记', color: 'success' })
  } catch (error) {
    toast.add({ title: errorMessage(error, '登记失败'), color: 'error' })
  } finally {
    saving.value = false
  }
}

async function setEnabled(build: OfficialBuild, enabled: boolean) {
  updating.value = build.id
  try {
    await $fetch(`/api/admin/mod-builds/${encodeURIComponent(build.id)}`, {
      method: 'PUT',
      body: { enabled, notes: build.notes },
    })
    await refresh()
    toast.add({ title: enabled ? '构建已启用' : '构建已停用', color: 'success' })
  } catch (error) {
    toast.add({ title: errorMessage(error, '更新失败'), color: 'error' })
  } finally {
    updating.value = ''
  }
}
</script>

<template>
  <div class="space-y-6">
    <div class="space-y-3 rounded-(--ui-radius) border border-(--ui-border) p-4">
      <p class="font-medium">登记官方赞助版构建</p>
      <div class="grid gap-3 sm:grid-cols-2">
        <UInput v-model="form.minecraftVersion" placeholder="Minecraft 版本，例如 1.21.1" />
        <UInput v-model="form.modVersion" placeholder="模组版本" />
      </div>
      <UInput
        v-model="form.artifactSha256"
        class="font-mono"
        maxlength="64"
        placeholder="最终 JAR 的 SHA-256（64 位十六进制）"
      />
      <UInput v-model="form.notes" placeholder="备注（可选）" />
      <UButton :loading="saving" @click="registerBuild">登记并启用</UButton>
    </div>

    <p v-if="status === 'pending'" class="text-sm text-(--ui-text-dimmed)">加载中…</p>
    <p v-else-if="!data?.builds.length" class="text-sm text-(--ui-text-dimmed)">
      尚未登记官方构建。
    </p>
    <div v-else class="space-y-3">
      <article
        v-for="build in data.builds"
        :key="build.id"
        class="rounded-(--ui-radius) border border-(--ui-border) p-4"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :color="build.enabled ? 'success' : 'neutral'" variant="subtle">
            {{ build.enabled ? '已启用' : '已停用' }}
          </UBadge>
          <span class="font-medium">MC {{ build.minecraftVersion }} · {{ build.modVersion }}</span>
        </div>
        <p class="mt-2 break-all font-mono text-xs text-(--ui-text-muted)">
          {{ build.artifactSha256 }}
        </p>
        <p v-if="build.notes" class="mt-2 text-sm text-(--ui-text-muted)">{{ build.notes }}</p>
        <div class="mt-3 flex items-center justify-between gap-3">
          <span class="truncate text-xs text-(--ui-text-dimmed)">{{ build.id }}</span>
          <UButton
            size="xs"
            :color="build.enabled ? 'error' : 'primary'"
            variant="subtle"
            :loading="updating === build.id"
            @click="setEnabled(build, !build.enabled)"
          >
            {{ build.enabled ? '停用' : '启用' }}
          </UButton>
        </div>
      </article>
    </div>
  </div>
</template>
