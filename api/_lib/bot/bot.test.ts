import { describe, expect, it } from 'vitest'
import { botBillablePremium } from './data.js'
import { splitText } from './whatsapp.js'
import { sessionExpired } from './store.js'
import {
  payablePolicies, claimablePolicies, periodLabel, billingCycleMonths, HECTARAGE_OPTIONS,
} from './handlers/flowHelpers.js'
import { isNationalId, isEcocashPhone, parseDob, pickIndex } from './helpers.js'
import { policyTermDates } from '../policyTerm.js'
import { normalizeMsisdn } from '../ecocashInstant.js'
import { REG_HANDLERS } from './handlers/registration.js'
import { CLIENT_HANDLERS } from './handlers/client.js'
import { AGENT_HANDLERS } from './handlers/agent.js'
import type { BotPolicy, BotProduct, WaSession } from './types.js'

function policy(overrides: Partial<BotPolicy> = {}): BotPolicy {
  return {
    id: 'policy-id', policyNumber: 'POL001', productId: 'product-id',
    productName: 'Family Funeral', productCategory: 'funeral',
    premium: 10, coverAmount: 1000, status: 'active', dependants: [],
    ...overrides,
  }
}

const sessionAt = (iso: string): WaSession => ({
  id: 's', phone_number: '263771234567', contact_type: 'client', state: 'CLIENT_MENU',
  note: {}, is_expired: false, created_at: iso, updated_at: iso,
})

describe('bot billing rules', () => {
  it('bills ordinary individual policies per covered head', () => {
    expect(botBillablePremium(policy({
      dependants: [
        { name: 'Child', premium: 4 },
        { name: 'Spouse' },
        { name: ' ', premium: 99 },
      ],
    }))).toBe(24)
  })

  it('bills agriculture once, not per attached name', () => {
    expect(botBillablePremium(policy({
      productCategory: 'agriculture', premium: 500,
      dependants: [{ name: 'Field', premium: 10 }, { name: 'Barn' }],
    }))).toBe(500)
  })

  it('bills only named roster members for group and once-off packages', () => {
    const billed = policy({
      premium: 7, coverScope: 'team', onceOff: true,
      dependants: [{ name: 'A' }, { name: 'B', premium: 8 }, { name: ' ', premium: 100 }],
    })
    expect(botBillablePremium(billed)).toBe(15)
  })

  it('uses agriculture’s 12-month settlement cycle and annual label', () => {
    const agri = policy({ productCategory: 'agriculture' })
    expect(billingCycleMonths(agri)).toBe(12)
    expect(periodLabel(agri)).toBe('/yr')
    expect(periodLabel(policy({ onceOff: true }))).toBe('/term')
  })
})

describe('bot policy selection rules', () => {
  it('does not offer closed policies or settled once-off packages for payment', () => {
    const policies = [
      policy({ status: 'active' }),
      policy({ status: 'cancelled', policyNumber: 'X1' }),
      policy({ status: 'expired', policyNumber: 'X2' }),
      policy({ status: 'active', onceOff: true, policyNumber: 'X3' }),
      policy({ status: 'pending', onceOff: true, policyNumber: 'X4' }),
      policy({ status: 'pending', policyNumber: 'X5' }),
    ]
    expect(payablePolicies(policies).map(p => p.policyNumber)).toEqual(['POL001', 'X4', 'X5'])
  })

  it('only allows claims on live or waiting-period cover', () => {
    const policies = [
      policy({ status: 'active', policyNumber: 'A' }),
      policy({ status: 'waiting_period', policyNumber: 'W' }),
      policy({ status: 'pending', policyNumber: 'P' }),
      policy({ status: 'expired', policyNumber: 'E' }),
    ]
    expect(claimablePolicies(policies).map(p => p.policyNumber)).toEqual(['A', 'W'])
  })
})

describe('bot input and session handling', () => {
  it('normalizes the supported national ID and EcoCash formats', () => {
    expect(isNationalId('63-2118532 K 12')).toBe(true)
    expect(isNationalId('123')).toBe(false)
    expect(isEcocashPhone('0771234567')).toBe(true)
    expect(isEcocashPhone('+263771234567')).toBe(true)
    expect(isEcocashPhone('00263771234567')).toBe(true)
    expect(isEcocashPhone('0712345678')).toBe(false)
    expect(normalizeMsisdn('0771234567')).toBe('263771234567')
    expect(normalizeMsisdn('00263771234567')).toBe('263771234567')
    expect(normalizeMsisdn('2630771234567')).toBe('263771234567')
  })

  it('rejects impossible dates of birth', () => {
    expect(parseDob('17-09-1980')).toBe('1980-09-17')
    expect(parseDob('32-01-1980')).toBeNull()
    expect(parseDob('tomorrow')).toBeNull()
  })

  it('accepts only one-based numeric menu picks', () => {
    expect(pickIndex('1', 3)).toBe(0)
    expect(pickIndex('3', 3)).toBe(2)
    expect(pickIndex('0', 3)).toBeNull()
    expect(pickIndex('4', 3)).toBeNull()
    expect(pickIndex('hello', 3)).toBeNull()
  })

  it('expires sessions from last activity rather than first creation', () => {
    const staleCreate = new Date(Date.now() - 120 * 60 * 1000).toISOString()
    const freshUpdate = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const s = sessionAt(staleCreate)
    s.updated_at = freshUpdate
    expect(sessionExpired(s)).toBe(false)
    s.updated_at = staleCreate
    expect(sessionExpired(s)).toBe(true)
  })

  it('splits long replies without emitting an oversized text body', () => {
    const chunks = splitText(`${'line of text\n'.repeat(600)}`)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(c => c.length <= 4000)).toBe(true)
    expect(chunks.every(Boolean)).toBe(true)
  })
})

describe('product terms and agriculture capture', () => {
  it('uses the fixed Field-to-Floor season for tobacco cover', () => {
    const tobacco: BotProduct = {
      id: 'tobacco', name: 'Tobacco Field to Floor', code: 'TOB',
      category: 'agriculture', premium: 10, coverAmount: 100, active: true,
    }
    expect(policyTermDates(tobacco)).toEqual({ start: '2026-11-15', end: '2027-08-31' })
    expect(HECTARAGE_OPTIONS).toEqual([0.5, 1, 1.5, 2, 2.5, 3])
  })

  it('uses a one-year term for ordinary products', () => {
    const product: BotProduct = {
      id: 'funeral', name: 'Family Funeral', code: 'FCP',
      category: 'funeral', premium: 10, coverAmount: 100, active: true,
    }
    const { start, end } = policyTermDates(product)
    expect(end > start).toBe(true)
  })
})

describe('state map completeness', () => {
  const expected = {
    unknown: [
      'REG_MENU', 'REG_NAME', 'REG_ID', 'REG_DOB', 'REG_GENDER', 'REG_GENDER_OTHER', 'REG_EMAIL',
      'REG_PRODUCT', 'REG_CHRONIC', 'REG_CHRONIC_DETAILS',
      'REG_AGRI_GROWER', 'REG_AGRI_CONTRACTOR', 'REG_AGRI_HECTARAGE',
      'REG_CURRENCY', 'REG_METHOD', 'REG_ECOCASH', 'REG_CONFIRM',
    ],
    client: [
      'CLIENT_MENU', 'CPAY_POLICY', 'CPAY_MONTHS',
      'CPAY_CURRENCY', 'CPAY_METHOD', 'CPAY_ECOCASH', 'CPAY_CONFIRM',
      'CVIEW_SEL', 'CADD_PRODUCT', 'CADD_CHRONIC', 'CADD_CHRONIC_DETAILS',
      'CADD_AGRI_GROWER', 'CADD_AGRI_CONTRACTOR', 'CADD_AGRI_HECTARAGE',
      'CADD_CURRENCY', 'CADD_METHOD', 'CADD_ECOCASH', 'CADD_CONFIRM',
      'CCLAIM_POLICY', 'CCLAIM_DOC', 'CDEP_MENU', 'CDEP_REMOVE_ID',
      'CDEP_NAME', 'CDEP_ID', 'CDEP_DOB', 'CDEP_GENDER', 'CDEP_GENDER_OTHER', 'CDEP_REL',
      'CDEP_POLICY', 'CDEP_PRODUCT', 'CDEP_CHRONIC', 'CDEP_CHRONIC_DETAILS',
      'CDEP_CURRENCY', 'CDEP_METHOD', 'CDEP_ECOCASH', 'CDEP_CONFIRM',
    ],
    agent: [
      'AGENT_MENU', 'AC_NAME', 'AC_ID', 'AC_DOB', 'AC_GENDER', 'AC_GENDER_OTHER', 'AC_PHONE', 'AC_EMAIL',
      'AC_PRODUCT', 'AC_CHRONIC', 'AC_CHRONIC_DETAILS',
      'AC_AGRI_GROWER', 'AC_AGRI_CONTRACTOR', 'AC_AGRI_HECTARAGE',
      'AC_CURRENCY', 'AC_METHOD', 'AC_ECOCASH', 'AC_CONFIRM',
      'AD_HOLDER_ID', 'AD_POLICY', 'AD_NAME', 'AD_ID', 'AD_DOB', 'AD_GENDER', 'AD_GENDER_OTHER',
      'AD_REL', 'AD_PRODUCT', 'AD_CHRONIC', 'AD_CHRONIC_DETAILS',
      'AD_CURRENCY', 'AD_METHOD', 'AD_ECOCASH', 'AD_CONFIRM',
      'APAY_ID', 'APAY_POLICY', 'APAY_MONTHS',
      'APAY_CURRENCY', 'APAY_METHOD', 'APAY_ECOCASH', 'APAY_CONFIRM',
    ],
  }

  it('has a handler for every registration, client and agent state', () => {
    const maps = { unknown: REG_HANDLERS, client: CLIENT_HANDLERS, agent: AGENT_HANDLERS }
    for (const [audience, states] of Object.entries(expected)) {
      const map = maps[audience as keyof typeof maps]
      for (const state of states) expect(typeof map[state], `${audience}.${state}`).toBe('function')
    }
  })
})
