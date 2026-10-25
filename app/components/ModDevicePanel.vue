<script setup lang="ts">
interface ModDevice {
  id: string
  installId: string
  deviceName: string
  minecraftName: string
  credentialVersion: number
  boundAt: string
  lastSeenAt: string | null
  revokedAt: string | null
  revokeReason: string | null
  cooldownHours: number
  remainingCooldownHours: number
}

interface DevicesResponse {
  ok: boolean
  device: ModDevice | null
  legacyActive: boolean
}

const toast = useToast()
const busy = ref(false)
const { data, refresh, status } = await useFetch<DevicesResponse>('/api/mod/devices', {
  server: false,
})

const device = computed(() => data.value?.device ?? null)
const legacyActive = computed(() => data.value?.legacyActive ?? false)

function fmt(iso: string | null) {
  return iso ? new Date(iso).toLocaleString('zh-CN') : '—'
}

async function revoke() {
  if (!confirm('吊销后本机将在下次联网检查时失去赞助授权。确定继续？')) return
  busy.value = true
  try {
    await $fetch('/api/mod/devices/revoke', { method: 'POST' })
    toast.add({ title: '设备凭证已吊销', color: 'success' })
    await refresh()
  } catch (error) {
    const e = error as { data?: { error?: string } }
    toast.add({ title: e.data?.error ?? '吊销失败', color: 'error' })
  } finally {
    busy.value = false
  }
}

async function revokeLegacy() {
  if (!confirm('确定吊销旧式长 token？已保存该 token 的旧客户端将无法继续续期。')) return
  busy.value = true
  try {
    await $fetch('/api/mod/token/reset', { method: 'POST' })
    toast.add({ title: '旧式凭证已吊销', color: 'success' })
    await refresh()
  } catch (error) {
    const e = error as { data?: { error?: string } }
    toast.add({ title: e.data?.error ?? '吊销失败', color: 'error' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="status === 'pending'" class="text-sm text-(--ui-text-dimmed)">加载中…</div>

  <div v-else-if="!device" class="space-y-3">
    <p class="text-sm text-(--ui-text-muted)">
      尚未绑定游戏客户端。请在模组内打开“赞助授权”，获取一次性绑定码后前往绑定页确认。
    </p>
    <UButton to="/mod/pair" variant="subtle">打开绑定页</UButton>
    <UAlert
      v-if="legacyActive"
      color="warning"
      variant="subtle"
      title="仍有旧式长 token"
      description="旧客户端仍可继续使用；完成设备码迁移后可手动吊销。"
    />
    <UButton
      v-if="legacyActive"
      color="error"
      variant="ghost"
      :loading="busy"
      @click="revokeLegacy"
    >
      吊销旧式凭证
    </UButton>
  </div>

  <div v-else class="space-y-4">
    <div class="rounded-(--ui-radius) border border-(--ui-border) p-4 text-sm">
      <div class="flex flex-wrap items-center gap-2">
        <UBadge :color="device.revokedAt ? 'error' : 'success'" variant="subtle" size="sm">
          {{ device.revokedAt ? '已吊销' : '已绑定' }}
        </UBadge>
        <span class="font-medium">{{ device.deviceName || 'Minecraft 客户端' }}</span>
      </div>
      <dl class="mt-3 grid grid-cols-2 gap-y-1 text-(--ui-text-muted)">
        <dt>安装标识</dt>
        <dd class="truncate font-mono text-xs">{{ device.installId }}</dd>
        <dt>Minecraft 账号</dt>
        <dd>{{ device.minecraftName || '未提供' }}</dd>
        <dt>绑定时间</dt>
        <dd>{{ fmt(device.boundAt) }}</dd>
        <dt>最近续期</dt>
        <dd>{{ fmt(device.lastSeenAt) }}</dd>
        <dt>换绑冷却</dt>
        <dd>
          {{
            device.remainingCooldownHours > 0
              ? `还需 ${device.remainingCooldownHours} 小时`
              : '可换绑'
          }}
        </dd>
      </dl>
    </div>

    <div class="flex flex-wrap gap-3">
      <UButton
        v-if="!device.revokedAt"
        color="error"
        variant="subtle"
        :loading="busy"
        @click="revoke"
      >
        紧急吊销
      </UButton>
      <UButton to="/mod/pair" variant="ghost">输入新绑定码</UButton>
      <UButton
        v-if="legacyActive"
        color="error"
        variant="ghost"
        :loading="busy"
        @click="revokeLegacy"
      >
        吊销旧式凭证
      </UButton>
    </div>

    <p class="text-xs text-(--ui-text-dimmed)">
      紧急吊销立即停止该设备继续续期，不受冷却限制；绑定另一台设备仍需遵守
      {{ device.cooldownHours }} 小时换绑冷却。离线 License 会在签名截止时间到达后失效。
    </p>
  </div>
</template>
