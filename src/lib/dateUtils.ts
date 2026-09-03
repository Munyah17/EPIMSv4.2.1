/** House date format: DD-MON-YYYY (e.g. 08-AUG-1999), everywhere. */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * A Date's own calendar day, as YYYY-MM-DD -- for storing or comparing a
 * business date (a start date, a due date, a payment date), never a moment
 * in time.
 *
 * `date.toISOString().split('T')[0]` looks equivalent but is not: it
 * converts to UTC first, and Zimbabwe is UTC+2 with no DST, so any local
 * time between midnight and 2am reads as the previous UTC day -- and a date
 * built from calendar fields (`new Date(year, month, day)`, always local
 * midnight) is affected for the entire day, every time, since local
 * midnight is 22:00 UTC the day before. That's precisely what pinned a new
 * policy's assigned start date to the wrong day for days at a stretch. This
 * reads the fields straight off the Date in local time -- the reverse of
 * how formatDate above already does it -- so it can never disagree with
 * what a person looking at their own calendar would call today.
 */
export function toIsoDate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad2(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
const MONTHS_LONG = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']

export function formatDateLong(value: string | Date | null | undefined): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  return `${WEEKDAYS[d.getDay()]}, ${pad2(d.getDate())} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`
}
