<script setup lang="ts">
const toast = useToast()
const { data, refresh } = await useFetch<{ config: Record<string, unknown> }>('/api/admin/config', { server: false })
const saving = ref('')
const announcementText = ref('[]')
watch(data, (value) => { announcementText.value = JSON.stringify(value?.config.announcements ?? [], null, 2) }, { immediate: true })
async function saveNumber(key: string, value: unknown) { saving.value = key; try { await $fetch(`/api/admin/config/${key}`, { method: 'PUT', body: { value: Number(value) } }); await refresh(); toast.add({ title: '已保存', color: 'success' }) } catch (error) { toast.add({ title: (error as { data?: { error?: string } }).data?.error ?? '保存失败', color: 'error' }) } finally { saving.value = '' } }
async function saveAnnouncements() { try { await $fetch('/api/admin/config/announcements', { method: 'PUT', body: { value: JSON.parse(announcementText.value) } }); await refresh(); toast.add({ title: '公告已保存', color: 'success' }) } catch { toast.add({ title: '公告 JSON 格式无效或保存失败', color: 'error' }) } }
</script>
<template><div class="space-y-5"><div v-for="key in ['license_ttl_hours','rebind_cooldown_hours','offline_grace_days']" :key="key" class="flex items-center gap-3"><UInput :model-value="String(data?.config[key] ?? '')" type="number" class="w-48" @update:model-value="saveNumber(key, $event)" /><span class="text-sm text-(--ui-text-muted)">{{ key }}</span></div><div><p class="mb-2 text-sm text-(--ui-text-muted)">公告 JSON</p><UTextarea v-model="announcementText" :rows="10" /><UButton size="sm" class="mt-2" @click="saveAnnouncements">保存公告</UButton></div></div></template>
