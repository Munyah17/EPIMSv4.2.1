/**
 * Policy Terms & Conditions.
 *
 * Every policy document (exportUtils.ts) appends the terms that apply to
 * THAT policy's product: its own product exclusion schedule followed by
 * the shared General Conditions — not every schedule the company issues.
 * A funeral policy carries funeral exclusions; a health policy never
 * ships tobacco terms stapled to it. The wording is contractual, so it
 * is kept verbatim as issued. policyTermsFor() answers which schedule a
 * product maps to.
 */

export interface PolicyTerms {
  /** e.g. "Funeral Cash Plan" */
  productTitle: string
  /** Heading above the exclusions, e.g. "Funeral Cash Plan Major Exclusions" */
  exclusionsHeading: string
  /** The "The Insurer will not be liable..." lead-in sentence. */
  exclusionsIntro: string
  exclusions: string[]
}

const FUNERAL: PolicyTerms = {
  productTitle: 'Funeral Cash Plan',
  exclusionsHeading: 'Funeral Cash Plan Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim for death which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
  exclusions: [
    'All claims occurring within 3 months of commencement or reinstatement of the policy',
    'All claims arising from a lapsed policy or a closed policy',
    'War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power, or the Insured Person engaging in military duty or military exercises with any armed force of any country or international authority.',
    'Suicide, while sane or insane.',
    'Engaging in (or practicing for or taking part in training peculiar to) underwater activities necessitating the use of artificial breathing apparatus, climbing or mountaineering necessitating the use of ropes or guides, potholing, parachuting, hang-gliding, winter sports involving snow and ice.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Epidemics as defined and declared by the World Health Organisation standards.',
    'Where the funeral cash plan has not been paid, the rider policy will not be honoured.',
    'All exclusions which apply to the funeral cash plan, also does apply to the rider policy.',
  ],
}

const HOSPITAL: PolicyTerms = {
  productTitle: 'Hospital Cash Plan',
  exclusionsHeading: 'Hospital Cash Plan Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim for hospitalisation due to Bodily Injury, Illness, Accidental Disability which is directly or indirectly caused by, arising from, contributed to by, aggravated by, connected with or resulting from any of the following:',
  exclusions: [
    'All claims occurring within 3 months of commencement or reinstatement of the policy',
    'War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power, or the Insured Person engaging in military duty or military exercises with any armed force of any country or international authority.',
    'Intentional self-inflicted injury or attempted suicide, while sane or insane.',
    'Engaging in (or practicing for or taking part in training peculiar to) underwater activities necessitating the use of artificial breathing apparatus, climbing or mountaineering necessitating the use of ropes or guides, potholing, parachuting, hang-gliding, winter sports involving snow and ice, professional sports or racing other than on foot.',
    'Engaging in aviation, other than as a fare-paying passenger in a fixed-wing aircraft provided and operated by an airline or air charter company which is duly licensed for the regular transportation of fare-paying passengers, or in a helicopter provided and operated by an airline which is duly licensed for the regular transportation of fare-paying passengers provided such helicopter is operating only between established commercial airports and/or licensed commercial heliports.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Driving a motor vehicle while the blood alcohol level of the Insured Person is higher than that permitted by law, irrespective of whether such action causes an accident or not.',
    'Maternity.',
    'Hospitalisation where there are no objective indications or impairment in normal health, routine physical or any other examination.',
    'Pre-Existing Medical Conditions as defined herein.',
    'The Insured Person having taken a drug, unless it is proved that the drug was taken in accordance with proper medical prescription and not for the treatment of a drug addiction.',
    'Any psychological or psychiatric disease or disorder including depression and Post Traumatic Stress Disorder.',
    'Confinement in an establishment which is not a Hospital, as defined herein.',
    'Operations, treatments and examinations for obesity, cosmetic purposes or of the Insured Person\u2019s own choosing which has no connection with any Illness.',
    'Treatment of infertility or the artificial insemination of a person.',
    'Hospitalisation as a consequence of breast reduction or enlargement operations and/or treatment of cystic fibrosis.',
    'Dental conditions and treatment.',
    'Any hospitalisation not recommended by a qualified Physician.',
    'Any hospitalisation undertaken in nature, cure clinics or hydros or during periods of quarantine.',
    'Hospitalisation due to cosmetic or plastic surgery except in the case of bodily reconstruction after Injury.',
    'Alcohol or drug dependence syndrome including treatment of any medical condition which, in the opinion of the Insurer\u2019s consulting Physician, is considered to be either an underlying cause of, or directly attributable to, alcohol or drug dependence syndrome.',
    'Hospitalisation for the investigation of pain or pain-related conditions and the treatment thereof, which in this context includes bed rest, traction, physiotherapy, spinal blocks, medication or intravenous medication.',
    'Any event traceable to psychiatric trauma and the Insured Person\u2019s state of mental or physical health prior to or after the event that gives rise to a claim.',
    'Visible and non-visible soft tissue injuries excluding clinically confirmed ligament and tendon damage that requires surgical intervention.',
    'Claims as a result of hospitalisation out of the Republic of Zimbabwe',
    'Hospitalisation due to pandemic or epidemic as declared by the World Health Organisation or the Zimbabwean health ministry.',
  ],
}

const LEGAL: PolicyTerms = {
  productTitle: 'Legal Insurance',
  exclusionsHeading: 'Legal Aid Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim which is directly or indirectly caused by, arising from, contributed to by, aggravated by, connected with or resulting from any of the following:',
  exclusions: [
    'Marital, family and related matters',
    'Defamation, insult, verbal abuse or any other infringement of a member\u2019s personality, reputation or dignity. However, cover extends to the insured if sued for defamation, insult or verbal abuse',
    'Commercial activities i.e., any legal costs incurred in business or professional undertaking',
    'Matters in which insured does not have a direct proprietary and/or financial interest.',
    'Matters in which insured\u2019s prospects of success are evidently dim.',
    'Matters in which the cause of action arose before the inception of insurance.',
    'Matters where no dispute is apparent, e.g. civil or administrative issues where there is no dispute with another person.',
    'Agreements of sale of property, moveable or immoveable, corporeal or incorporeal.',
    'Conveyancing fees and transfer duties.',
    'Crimes committed before the inception of cover are not covered.',
    'Costs of winding up a deceased estate',
    'Serious offences such as murder, rape, robbery, treason, culpable homicide, sexual offences, aggravated assault, kidnapping, dealing in drugs, fraud, where the insured previously got indemnified for such offences before. There is no cover for a second such offence, whether or not there was a conviction for the offence.',
    'Cases in which an admission of guilt fine is payable.',
    'Cases involving a claim that has been repudiated under this policy.',
    'Any action instituted against Motions Microinsurance under any circumstances whatsoever.',
    'Any rights of the insured obtained through a cession of rights, surety, delegation or assignment.',
    'Acts done in pursuit of insured\u2019s business interest as a company, partnership, shareholder or director.',
    'Actions instituted by the insured for revenge or are based on malice. Malicious prosecution is not covered.',
    'Drafting of contracts and other agreements of a similar nature.',
    'Insured\u2019s rights and obligations as a land-lord.',
    'Judicial management, liquidation and insolvency proceedings, sequestrations and rehabilitation costs.',
    'Private corporations, public corporations, partnerships and co-operatives.',
    'Political disputes, threats and violence.',
    'Riots, civil commotion, public disorder, political disorder or any acts calculated to bring any of the above.',
    'Mutiny, military uprising, insurrection, revolution, rebellion or acts arising out of the declaration of martial law, state of emergency or siege.',
    'War, invasion, act of foreign enemy, hostilities or war-like operations or civil war.',
    'Challenge against Immigration Laws of Zimbabwe by a foreigner',
  ],
}

const TOBACCO: PolicyTerms = {
  productTitle: 'Tobacco Insurance (Field to Floor)',
  exclusionsHeading: 'Small Scale Tobacco Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim for death which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
  exclusions: [
    'Damages or claims arising from arson, fraudulent activities',
    'Claims arising from war, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Acts of God',
  ],
}

/** No exclusion schedule has been issued for this product yet — the page
 *  still prints, carrying the general conditions, so no policy document
 *  ever ships without its terms. */
const GENERAL: PolicyTerms = {
  productTitle: '',
  exclusionsHeading: 'General Conditions',
  exclusionsIntro: 'This policy is subject to the Policy Terms and Conditions of the Insurer. Without limiting those terms, cover under this policy is subject to the following:',
  exclusions: [
    'Claims occurring within the waiting period stated in the policy schedule, calculated from the commencement or reinstatement of the policy.',
    'Claims arising from a lapsed policy or a closed policy.',
    'War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, rebellion, revolution, insurrection or military or usurped power.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Epidemics or pandemics as defined and declared by the World Health Organisation or the Zimbabwean health ministry.',
  ],
}

/** The terms document for ONE policy: its own product's exclusion
 *  schedule, then the General Conditions every policy shares. Products
 *  with no schedule of their own (e.g. Medical Aid) print just the
 *  General Conditions — no policy document ships without its terms, and
 *  none carries a schedule for a product it isn't.
 *
 *  Field-to-Floor is the exception: its cover INCLUDES a flat $500
 *  funeral benefit for the grower, so the funeral schedule is part of
 *  the contract — the document carries tobacco exclusions AND funeral
 *  exclusions, in that order. */
export function termsPagesFor(product: { name?: string; category?: string }): PolicyTerms[] {
  const own = policyTermsFor(product)
  if (own === TOBACCO) return [TOBACCO, FUNERAL, GENERAL]
  return own === GENERAL ? [GENERAL] : [own, GENERAL]
}

/** Picks the exclusion schedule for a product — the same keyword rules the
 *  policy-number prefixes use, so the two can never disagree about which
 *  product a policy is for. */
export function policyTermsFor(product: { name?: string; category?: string }): PolicyTerms {
  const name = (product.name ?? '').toLowerCase()
  if (name.includes('tobacco') || name.includes('field to floor')) return TOBACCO
  if (name.includes('funeral') || name.includes('burial')) return FUNERAL
  if (name.includes('hospital')) return HOSPITAL
  if (name.includes('legal')) return LEGAL
  if (name.includes('medical')) return GENERAL
  switch (product.category) {
    case 'funeral': return FUNERAL
    case 'agriculture': return TOBACCO
    default: return GENERAL
  }
}
