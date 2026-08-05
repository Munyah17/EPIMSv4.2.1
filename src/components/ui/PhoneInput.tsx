import { useState, useRef, useEffect } from 'react'
import { COUNTRIES, splitPhone, type Country } from '../../lib/countries'

interface Props {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}

export default function PhoneInput({ value, onChange, placeholder }: Props) {
  const parsed = splitPhone(value)
  const [country, setCountry] = useState<Country>(parsed.country)
  const [local, setLocal] = useState(parsed.local)
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  // Re-sync from parent if the value was reset externally (e.g. form cleared)
  useEffect(() => {
    if (value === '') { setCountry(COUNTRIES[0]); setLocal('') }
  }, [value])

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  const commit = (nextCountry: Country, nextLocal: string) => {
    onChange(nextLocal ? `${nextCountry.dial} ${nextLocal}`.trim() : '')
  }

  const selectCountry = (c: Country) => {
    setCountry(c)
    setOpen(false)
    setSearch('')
    commit(c, local)
  }

  const filtered = COUNTRIES.filter(c =>
    !search || c.name.toLowerCase().includes(search.toLowerCase()) || c.dial.includes(search)
  )

  return (
    <div className="phone-input" ref={rootRef}>
      <button type="button" className="phone-input-country" onClick={() => setOpen(o => !o)}>
        <span>{country.flag}</span>
        <span className="phone-input-dial">{country.dial}</span>
        <span className="phone-input-caret">▾</span>
      </button>
      <input
        className="form-control phone-input-number"
        type="tel"
        value={local}
        placeholder={placeholder ?? '77 123 4567'}
        onChange={e => { setLocal(e.target.value); commit(country, e.target.value) }}
      />
      {open && (
        <div className="phone-input-dropdown">
          <input
            className="form-control phone-input-search"
            placeholder="Search country or code…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoFocus
          />
          <div className="phone-input-list">
            {filtered.length === 0 ? (
              <div className="phone-input-empty">No matches.</div>
            ) : filtered.map(c => (
              <button
                type="button"
                key={c.code}
                className={`phone-input-option${c.code === country.code ? ' active' : ''}`}
                onClick={() => selectCountry(c)}
              >
                <span>{c.flag}</span>
                <span className="phone-input-option-name">{c.name}</span>
                <span className="phone-input-option-dial">{c.dial}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
