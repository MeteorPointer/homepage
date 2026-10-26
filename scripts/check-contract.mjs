import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const [
  example,
  workshop,
  admin,
  auth,
  minePage,
  modDevice,
  devicePanel,
  pairPage,
  migration,
  deviceIdentityMigration,
  license,
  authComposable,
  accountPage,
  roles,
  buildMigration,
  modBuilds,
  buildsTab,
] = await Promise.all([
  read('.dev.vars.example'),
  read('server/hono/routes/workshop.ts'),
  read('server/hono/routes/admin.ts'),
  read('server/hono/routes/auth.ts'),
  read('app/pages/workshop/mine.vue'),
  read('server/hono/routes/modDevice.ts'),
  read('app/components/ModDevicePanel.vue'),
  read('app/pages/mod/pair.vue'),
  read('migrations/0006_mod_device_authorization.sql'),
  read('migrations/0007_mod_device_minecraft_name.sql'),
  read('server/hono/lib/license.ts'),
  read('app/composables/useAuth.ts'),
  read('app/pages/account.vue'),
  read('server/hono/lib/roles.ts'),
  read('migrations/0008_official_mod_builds.sql'),
  read('server/hono/lib/modBuilds.ts'),
  read('app/components/admin/BuildsTab.vue'),
])

assert(
  !example.includes('NUXT_PRISM_CLIENT_SECRET'),
  '.dev.vars.example must use Worker secret names',
)
assert(
  example.includes('PRISM_CLIENT_SECRET='),
  '.dev.vars.example must declare PRISM_CLIENT_SECRET',
)
assert(
  example.includes('PRISM_TEAM_READ_TOKEN='),
  '.dev.vars.example must declare PRISM_TEAM_READ_TOKEN',
)
assert(!workshop.includes('/:id/preview'), 'NBT preview endpoint must stay removed')
assert(workshop.includes('/mine/list'), 'my submissions endpoint must remain available')
assert(admin.includes('/workshop/:id/file/:index'), 'reviewer file endpoint must remain available')
assert(auth.includes('/profile'), 'profile endpoint must remain available')
assert(
  auth.includes("target.searchParams.delete('error')"),
  'successful login redirects must drop stale OAuth error parameters',
)
assert(
  authComposable.includes("url.searchParams.delete('error')"),
  'client login redirects must drop stale OAuth error parameters',
)
assert(
  accountPage.includes("if (user.value) return ''"),
  'authenticated account pages must hide stale OAuth errors',
)
assert(minePage.includes('/api/workshop/mine/list'), 'my submissions UI must remain connected')
assert(modDevice.includes('/pair/start'), 'device pairing start endpoint must remain available')
assert(modDevice.includes('/pair/poll'), 'device pairing poll endpoint must remain available')
assert(
  modDevice.includes('/license/refresh'),
  'device license refresh endpoint must remain available',
)
assert(modDevice.includes('/devices/revoke'), 'emergency device revocation must remain available')
assert(
  roles.includes("normalizeRoleKey(roleKey) === 'admin'"),
  'only the admin role may bypass the device rebind cooldown',
)
assert(
  modDevice.match(/isRebindCooldownExempt/g)?.length === 4,
  'admin cooldown exemption must cover confirm, poll, and device status',
)
assert(
  modDevice.includes('(? = 1 OR mod_devices.bound_at <= ?)'),
  'the atomic device upsert must honor the admin cooldown exemption',
)
assert(
  devicePanel.includes('管理员免冷却'),
  'the device panel must disclose the admin cooldown exemption',
)
assert(
  !devicePanel.includes('token.token'),
  'account UI must never display a long-lived device credential',
)
assert(pairPage.includes('/api/mod/pair/confirm'), 'pair confirmation page must remain connected')
assert(migration.includes('credential_hash'), 'device credentials must be stored by hash')
assert(migration.includes('UNIQUE COLLATE NOCASE'), 'pairing user codes must remain unique')
assert(
  deviceIdentityMigration.match(/ADD COLUMN minecraft_name/g)?.length === 2,
  'Minecraft account name must be stored on pairings and bound devices',
)
assert(modDevice.includes('minecraft_name'), 'device APIs must carry the Minecraft account name')
assert(
  pairPage.includes('Minecraft 账号'),
  'pair confirmation must show the Minecraft account name',
)
assert(license.includes('kid: keyId(env)'), 'License JWT must include kid for key rotation')
assert(
  buildMigration.includes('official_mod_builds') &&
    buildMigration.match(/ADD COLUMN artifact_sha256/g)?.length === 2,
  'official build hashes must be stored on pairings and devices',
)
assert(
  modBuilds.includes('artifactSha256') && modBuilds.includes('enabled = 1'),
  'build verification must require an enabled registered SHA-256',
)
assert(
  modDevice.match(/unofficial_build/g)?.length === 3,
  'pairing, polling, and refresh must reject unofficial builds',
)
assert(
  license.includes('license_version: 2 | 3') && modDevice.includes('issueLegacyLicense'),
  'v3 build-bound licenses must preserve the legacy v2 migration path',
)
assert(
  buildsTab.includes('/api/admin/mod-builds'),
  'admin UI must manage the official build registry',
)

console.log('contract checks passed')
