/**
 * Paynow's SDK ships no type declarations, so `import { Paynow } from 'paynow'`
 * raised TS7016 ("implicitly has an 'any' type") during the Vercel function
 * build for api/paynow.ts and api/paynow-webhook.ts.
 *
 * Declared rather than installed because there is no @types/paynow to install.
 * Only the surface these two functions actually use is described -- enough to
 * type-check the calls, without pretending to model the whole SDK.
 */
declare module 'paynow' {
  export interface PaynowPayment {
    add(item: string, amount: number): PaynowPayment
  }
  export interface PaynowResponse {
    success: boolean
    error?: string
    redirectUrl?: string
    pollUrl?: string
  }
  export interface PaynowStatus {
    status?: string
    amount?: string | number
    reference?: string
    paynowreference?: string
  }
  export class Paynow {
    constructor(integrationId: string, integrationKey: string, resultUrl?: string, returnUrl?: string)
    resultUrl: string
    returnUrl: string
    createPayment(reference: string, authEmail?: string): PaynowPayment
    send(payment: PaynowPayment): Promise<PaynowResponse>
    sendMobile(payment: PaynowPayment, phone: string, method: string): Promise<PaynowResponse>
    pollTransaction(pollUrl: string): Promise<PaynowStatus>
    parseStatusUpdate(raw: string): PaynowStatus
  }
}
