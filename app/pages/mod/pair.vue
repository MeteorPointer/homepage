<script setup lang="ts">
useHead({ title: '绑定游戏客户端 · NSUK' })

interface PairInfo {
  user_code: string
  device_name: string
  minecraft_name: string
  minecraft_version: string
  mod_version: string
  status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired'
  expires_at: string
}

const route = useRoute()
const { user, configured, level, login } = useAuth()
const toast = useToast()
const code = ref(typeof route.query.code === 'string' ? route.query.code : '')
const info = ref<PairInfo | null>(null)
const loading = ref(false)
const errorText = ref('')

function fmt(iso: string) {
  return new Date(iso).toLocaleString('zh-CN')
}

async function inspect() {
  loading.value = true
  errorText.value = ''
  try {
    info.value = await $fetch<PairInfo>('/api/mod/pair/info', {
      method: 'POST',
      body: { user_code: code.value },
    })
    code.value = info.value.user_code
  } catch (error) {
    const e = error as { data?: { error_description?: string; error?: string } }
    info.value = null
    errorText.value = e.data?.error_description ?? e.data?.error ?? '绑定码无效或已过期'
  } finally {
    loading.value = false
  }
}

async function confirmPairing() {
  if (!info.value) return
  loading.value = true
  try {
    await $fetch('/api/mod/pair/confirm', {
      method: 'POST',
      body: { user_code: info.value.user_code },
    })
    info.value.status = 'approved'
    toast.add({ title: '已确认绑定，请返回游戏', color: 'success' })
  } catch (error) {
    const e = error as { data?: { error_description?: string; error?: string } }
    errorText.value = e.data?.error_description ?? e.data?.error ?? '确认失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  if (code.value) void inspect()
})
</script>

<template>
  <div class="mx-auto max-w-xl px-6 py-12">
    <h1 class="text-2xl font-bold">绑定游戏客户端</h1>
    <p class="mt-2 text-sm text-(--ui-text-muted)">
      在游戏内打开 NSUK 赞助授权页，将显示的八位短码填到这里。官网不会接触你的密码或设备长期密钥。
    </p>

    <div class="mt-8 flex gap-3">
      <UInput
        v-model="code"
        class="flex-1 font-mono uppercase"
        placeholder="ABCD-EFGH"
        maxlength="9"
      />
      <UButton :loading="loading" @click="inspect">查询</UButton>
    </div>

    <UAlert v-if="errorText" class="mt-5" color="error" variant="subtle" :description="errorText" />

    <div v-if="info" class="mt-6 rounded-(--ui-radius) border border-(--ui-border) p-5">
      <div class="flex items-center justify-between gap-3">
        <span class="font-mono text-xl font-semibold">{{ info.user_code }}</span>
        <UBadge
          :color="
            info.status === 'pending'
              ? 'warning'
              : info.status === 'approved' || info.status === 'consumed'
                ? 'success'
                : 'error'
          "
          variant="subtle"
        >
          {{ info.status }}
        </UBadge>
      </div>
      <dl class="mt-4 grid grid-cols-2 gap-y-2 text-sm">
        <dt class="text-(--ui-text-muted)">设备名称</dt>
        <dd>{{ info.device_name }}</dd>
        <dt class="text-(--ui-text-muted)">Minecraft 账号</dt>
        <dd>{{ info.minecraft_name || '未提供' }}</dd>
        <dt class="text-(--ui-text-muted)">官方构建</dt>
        <dd>MC {{ info.minecraft_version }} · {{ info.mod_version }}</dd>
        <dt class="text-(--ui-text-muted)">过期时间</dt>
        <dd>{{ fmt(info.expires_at) }}</dd>
      </dl>

      <template v-if="info.status === 'pending'">
        <UAlert
          class="mt-5"
          color="warning"
          variant="subtle"
          title="请核对游戏中的短码"
          description="只有短码和设备名称都一致时才确认，避免替他人绑定设备。"
        />

        <div v-if="!user" class="mt-5">
          <UButton v-if="configured" @click="login(route.fullPath)">登录后确认</UButton>
        </div>
        <div v-else-if="level < 1" class="mt-5 text-sm text-(--ui-text-muted)">
          当前账号没有赞助资格，无法确认绑定。
        </div>
        <div v-else class="mt-5">
          <UButton :loading="loading" @click="confirmPairing">确认绑定</UButton>
        </div>
      </template>

      <UAlert
        v-else-if="info.status === 'approved' || info.status === 'consumed'"
        class="mt-5"
        color="success"
        variant="subtle"
        title="绑定已确认"
        description="返回游戏即可，模组会在后台自动完成授权。"
      />
    </div>
  </div>
</template>
