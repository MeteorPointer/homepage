import { readFile } from 'node:fs/promises'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

const [example, workshop, admin, auth, minePage] = await Promise.all([
  read('.dev.vars.example'),
  read('server/hono/routes/workshop.ts'),
  read('server/hono/routes/admin.ts'),
  read('server/hono/routes/auth.ts'),
  read('app/pages/workshop/mine.vue'),
])

assert(!example.includes('NUXT_PRISM_CLIENT_SECRET'), '.dev.vars.example must use Worker secret names')
assert(example.includes('PRISM_CLIENT_SECRET='), '.dev.vars.example must declare PRISM_CLIENT_SECRET')
assert(!workshop.includes("/:id/preview"), 'NBT preview endpoint must stay removed')
assert(workshop.includes("/mine/list"), 'my submissions endpoint must remain available')
assert(admin.includes("/workshop/:id/file/:index"), 'reviewer file endpoint must remain available')
assert(auth.includes("/profile"), 'profile endpoint must remain available')
assert(minePage.includes('/api/workshop/mine/list'), 'my submissions UI must remain connected')

console.log('contract checks passed')
