import { readdirSync } from 'node:fs'

const dir = new URL('../database/migrations', import.meta.url)
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
const pattern = /^(\d{8})_(\d{3})_[a-z0-9_-]+\.sql$/

if (!files.length) {
  console.error('database/migrations must contain at least one SQL migration.')
  process.exit(1)
}

const byDate = new Map()
for (const file of files) {
  const match = pattern.exec(file)
  if (!match) {
    console.error(`Invalid migration filename: ${file}\nExpected YYYYMMDD_NNN_description.sql`)
    process.exit(1)
  }
  const [, date, ordinal] = match
  const list = byDate.get(date) ?? []
  list.push(Number(ordinal))
  byDate.set(date, list)
}

for (const [date, ordinals] of byDate) {
  ordinals.sort((a, b) => a - b)
  ordinals.forEach((ordinal, index) => {
    if (ordinal !== index + 1) {
      console.error(`Migration ordinals for ${date} must be sequential from 001; found ${ordinals.join(', ')}`)
      process.exit(1)
    }
  })
}

console.log(`Checked ${files.length} SQL migration${files.length === 1 ? '' : 's'}.`)
