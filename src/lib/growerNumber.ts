export function normalizeGrowerNumber(raw: string | null | undefined): string {
  const value = String(raw ?? '').trim().replace(/\s+/g, '').toUpperCase()
  return value ? (value.startsWith('V') ? value : `V${value}`) : ''
}
