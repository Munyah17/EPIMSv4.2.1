/**
 * Policy Terms & Conditions.
 *
 * Every policy document (exportUtils.ts) appends the terms that apply to
 * THAT policy's product — and only that product's. A funeral policy
 * carries funeral terms; a tobacco policy carries tobacco terms plus
 * the Funeral Cash Plan schedule its rider rides on. There is no shared
 * General Conditions section. The wording is contractual, so it is kept
 * verbatim as issued. policyTermsFor() answers which schedule a product
 * maps to.
 */

export interface PolicyTerms {
  /** e.g. "Funeral Cash Plan" */
  productTitle: string
  /** Heading above the exclusions, e.g. "Funeral Cash Plan Major Exclusions" */
  exclusionsHeading: string
  /** The "The Insurer will not be liable..." lead-in sentence. */
  exclusionsIntro: string
  exclusions: string[]
  /** The product's full Terms & Conditions document — every section
   *  verbatim as issued. When present, the policy document prints the
   *  complete wording (preamble, currency, claims, exclusions and all)
   *  instead of only the exclusion schedule. */
  sections?: { heading: string; paragraphs: string[] }[]
}

const FUNERAL: PolicyTerms = {
  productTitle: 'Funeral Cash Plan',
  // The issued Funeral Cash Plan T&C, verbatim (Motions Funeral Cash
  // Plan — Terms and Conditions). Sections print in order on the policy
  // document's terms pages.
  sections: [
    { heading: 'Preamble', paragraphs: [
      'WHEREAS the Insured named in the Schedules hereto (hereinafter called the "Insured") has applied to Motions Microinsurance Company (Private) Limited as mentioned on the schedule hereto (hereinafter called the "Insurer/Motions or the Company") for a Funeral Cash Plan. The product pays a fixed sum assured in the event of death of the life covered provided all the terms and conditions have been met. There are no other benefits payable aside from the sum assured specified in the policy document.',
    ]},
    { heading: 'Currency', paragraphs: [
      'The product can be offered in any currency which is recognised as legal tender in Zimbabwe. The benefits are paid in line with the currency of the premiums.',
    ]},
    { heading: 'Claim Notification and Submission', paragraphs: [
      'The claim must be lodged as soon as possible after death but within 180 days. Death Certificate or Burial Order, Copy of ID of the applicant, Copies of IDs for at least 2 witnesses (with traceable relations) must be submitted, together with a fully completed claims forms (either physical or automated).',
    ]},
    { heading: 'Key Policy Terms and Conditions', paragraphs: [
      'Eligibility Requirements — The cover is open to all residents in Zimbabwe, and Zimbabweans who are resident in the diaspora — subject to approval by the Microinsurer. The policy holder must be at least 18 years and younger than 70 years. Children under the age of 18 and adults above 70 can be covered as dependants.',
      'Policy commencement date — All policies start from the 1st of the Month, upon payment of premiums and cover cannot be backdated. If the premiums are not paid by the 1st of the Month, cover will be lapsed from midnight on the 1st of the Month. A lapsed Policy can be re-instated upon payment of the Premium however no claim shall be paid for each month the policy was lapsed up to a maximum of 3 months following the reinstatement of the Policy. A policy in lapse for more than 3 months is rendered closed and the individual will have to apply again and go through the waiting. The policies\u2019 grace period is up to the 10th of the month.',
      'Premium Refund and Cooling Off Rights — There is no premium refunds for policy cancellation or any other reason after the cooling off period or if a claim has been lodged against the policy. The cooling off period shall be 30 days from the day of payment of first premium.',
      'Paid-up and Surrender Terms — There is no surrender or paid-up values.',
    ]},
    { heading: 'Exclusions', paragraphs: [
      'The Insurer will not be liable in respect of any claim for death which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
      '1. All claims occurring within the waiting period (3 months below 70 and 6 months above 70 years) of commencement or reinstatement of the policy.',
      '2. War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power, or the Insured Person engaging in military duty or military exercises with any armed force of any country or international authority.',
      '3. Suicide, while sane or insane.',
      '4. Engaging in (or practicing for or taking part in training peculiar to) underwater activities necessitating the use of artificial breathing apparatus, climbing or mountaineering necessitating the use of ropes or guides, potholing, parachuting, hang-gliding, winter sports involving snow and ice.',
      '5. The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
      '6. Epidemics as defined and declared by the World Health Organisation standards.',
    ]},
    { heading: 'Cessions', paragraphs: [
      'The policy can be ceded to a third party e.g., to cover credit while the insured was still alive.',
    ]},
    { heading: 'Policy changes', paragraphs: [
      'The policyholder can make changes to the level of benefits. Any changes are subject to underwriting and may result in new conditions being imposed. The Insurer reserves the right to review the premiums from time to time and a 30-day notice shall be provided before a review is effected.',
    ]},
  ],
  exclusionsHeading: 'Funeral Cash Plan Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim for death which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
  exclusions: [
    'All claims occurring within the waiting period (3 months below 70 and 6 months above 70 years) of commencement or reinstatement of the policy.',
    'War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power, or the Insured Person engaging in military duty or military exercises with any armed force of any country or international authority.',
    'Suicide, while sane or insane.',
    'Engaging in (or practicing for or taking part in training peculiar to) underwater activities necessitating the use of artificial breathing apparatus, climbing or mountaineering necessitating the use of ropes or guides, potholing, parachuting, hang-gliding, winter sports involving snow and ice.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Epidemics as defined and declared by the World Health Organisation standards.',
  ],
}

const HOSPITAL: PolicyTerms = {
  productTitle: 'Hospital Cash Plan',
  // The issued Hospital Cash Plan T&C, verbatim (Motions Hospital Cash
  // Product — Terms and Conditions).
  sections: [
    { heading: 'Preamble', paragraphs: [
      'WHEREAS the Insured named in the Schedules hereto (hereinafter called the "Insured") has applied to Motions Microinsurance Company (Private) Limited as mentioned on the schedule hereto (hereinafter called the "Insurer/Motions or the Company") for a Hospital Cash Back. This is not a medical aid product, but a medical insurance product which is not meant to indemnify medical costs.',
      'The benefits are payable for a maximum of 10 days per event or 20 days per annum. Hospitalization related to any chronic illness and/or pre-existing conditions will be limited to a maximum of 3 days per event, and a maximum of 6 days per Policy per year. The Insurer reserves the right to limit payment in terms of any duration of hospitalisation if, in the opinion of our Independent Medical Officer, the duration of admission is not justified. The Insurer further reserves the right to refuse payment in respect of claims resulting from hospitalisation at certain hospitals.',
    ]},
    { heading: 'Currency', paragraphs: [
      'All premiums are paid in advance and are based on the benefit option chosen by the insured. The product can be offered in any currency which is recognised as legal tender in Zimbabwe. The benefits are paid in line with the currency of the premiums.',
    ]},
    { heading: 'Claim Notification and Submission', paragraphs: [
      'The claim must be notified immediately after hospitalisation but within 30 (thirty) days. Ensure that Identity Documents for the Insured, Medical records from the hospital which prove the hospitalisation, Proof of payment for the hospitalisation (either the receipts or the medical aid used) and Letter of admission and discharge from a qualified Medical Practitioner are submitted for claim processing. Additional documents maybe requested by the Independent Medical officer to verify the claim.',
    ]},
    { heading: 'Key Policy Terms and Conditions', paragraphs: [
      'Eligibility Requirements — The cover is open to all residence in Zimbabwe who are older than 18 and younger than 60. Children under the age of 18 can be covered as dependants.',
      'Policy commencement date — All policies start from the 1st of the Month, upon payment of premiums and cover cannot be backdated. If the premiums are not paid by the 1st of the Month, cover will be lapsed from midnight on 1st of the Month. A lapsed Policy can be re-instated upon payment of the Premium however no claim shall be paid for hospitalisation due to illness for each month the policy was lapsed up to a maximum of 3 months following the reinstatement of the Policy. A policy in lapse for more than 3 months is rendered closed and the individual will have to apply again and go through the waiting period of 3 months for cover to resume. The policies\u2019 grace period is up to the 10th of the month.',
      'Premium Refund and Cooling Off Rights — There will be no premium refunds for policy cancellation or any other reason after the cooling off period or if a claim has been lodged against the policy. The cooling off period shall be 30 days from payment of first premium.',
      'Paid-up and Surrender Terms — There is no surrender or paid-up values.',
      'Waiting period — A period in which Motions will not pay for claims originating from any form of illness which leads to hospitalisation. Only claims as a direct consequence of an accident will be considered during the waiting period.',
    ]},
    { heading: 'Exclusions', paragraphs: [
      'The Insurer will not be liable in respect of any claim for hospitalisation due to Bodily Injury, Illness, Accidental Disability which is directly or indirectly caused by, arising from, contributed to by, aggravated by, connected with or resulting from any of the following:',
      '1. All claims occurring within 3 months of commencement or reinstatement of the policy, surgery 6 months, chronic and preexisting 12 months.',
      '2. War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, active participation in strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power, or the Insured Person engaging in military duty or military exercises with any armed force of any country or international authority.',
      '3. Intentional self-inflicted injury or attempted suicide, while sane or insane.',
      '4. Engaging in (or practicing for or taking part in training peculiar to) underwater activities necessitating the use of artificial breathing apparatus, climbing or mountaineering necessitating the use of ropes or guides, potholing, parachuting, hang-gliding, winter sports involving snow and ice, professional sports or racing other than on foot.',
      '5. Engaging in aviation, other than as a fare-paying passenger in a fixed-wing aircraft provided and operated by an airline or air charter company which is duly licensed for the regular transportation of fare-paying passengers, or in a helicopter provided and operated by an airline which is duly licensed for the regular transportation of fare-paying passengers provided such helicopter is operating only between established commercial airports and/or licensed commercial heliports.',
      '6. The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
      '7. Driving a motor vehicle while the blood alcohol level of the Insured Person is higher than that permitted by law, irrespective of whether such action causes an accident or not.',
      '8. Maternity.',
      '9. Hospitalisation where there are no objective indications or impairment in normal health, routine physical or any other examination.',
      '10. The Insured Person having taken a drug, unless it is proved that the drug was taken in accordance with proper medical prescription and not for the treatment of a drug addiction.',
      '11. Any psychological or psychiatric disease or disorder including depression and Post Traumatic Stress Disorder.',
      '12. Confinement in an establishment which is not a hospital, as defined herein.',
      '13. Operations, treatments and examinations for obesity, cosmetic purposes or of the Insured Person\u2019s own choosing which has no connection with any Illness.',
      '14. Treatment of infertility or the artificial insemination of a person.',
      '15. Hospitalisation as a consequence of breast reduction or enlargement operations and/or treatment of cystic fibrosis.',
      '16. Dental conditions and treatment.',
      '17. Any hospitalisation not recommended by a qualified Physician.',
      '18. Any hospitalisation undertaken in nature, cure clinics or hydros or during periods of quarantine.',
      '19. Hospitalisation due to cosmetic or plastic surgery except in the case of bodily reconstruction after Injury.',
      '20. Alcohol or drug dependence syndrome including treatment of any medical condition which, in the opinion of the Insurer\u2019s consulting Physician, is considered to be either an underlying cause of, or directly attributable to, alcohol or drug dependence syndrome.',
      '21. Hospitalisation for the investigation of pain or pain-related conditions and the treatment thereof, which in this context includes bed rest, traction, physiotherapy, spinal blocks, medication or intravenous medication.',
      '22. Any event traceable to psychiatric trauma and the Insured Person\u2019s state of mental or physical health prior to or after the event that gives rise to a claim.',
      '23. Visible and non-visible soft tissue injuries excluding clinically confirmed ligament and tendon damage that requires surgical intervention.',
      '24. Claims as a result of hospitalisation out of the Republic of Zimbabwe.',
      '25. Hospitalisation due to pandemic or epidemic as declared by the World Health Organisation or the Zimbabwean health ministry.',
    ]},
    { heading: 'Cessions', paragraphs: [
      'The policy can be ceded to a third party e.g., to cover credit prepayments during period of hospitalisation.',
    ]},
  ],
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
  productTitle: 'Tobacco (Small Scale Crop Insurance)',
  exclusionsHeading: 'Small Scale Tobacco Major Exclusions',
  exclusionsIntro: 'The Insurer will not be liable in respect of any claim for crop damage which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
  sections: [
    { heading: 'Preamble', paragraphs: [
      'WHEREAS the Insured named in the Schedules hereto (hereinafter called the "Insured") has applied to Motions Microinsurance Company (Private) Limited as mentioned on the schedule hereto (hereinafter called the "Insurer/Motions or the Company") for a policy of Field to Floor Tobacco insurance. In consideration of the Insured having actually paid the premium for the period of insurance or signed the TIMB stop order form, the Insurer will indemnify or compensate the Insured against loss or damage as described herein up to the Limit of Liability as stated in the Schedule hereto after receiving the premiums from the grower\u2019s contractor.',
    ]},
    { heading: 'Currency', paragraphs: [
      'The product will be insured in USD or any currency in which the farmer will sell their produce in.',
    ]},
    { heading: 'Claims Notification, Process and Settlement', paragraphs: [
      'The claim must be lodged as soon as possible after a loss has occurred and within 24 hours. The farmer will notify Motions through online, office calls or visits or through various channels as will be availed. Motions will appoint a loss adjustor or assessor within 24 hours of receipt of claim notification. Claim assessment record will be kept and a second assessment will be done within two to three weeks of loss if necessary. The final assessment will then produce a report detailing how much of the crop has been damaged and estimated payout. Actual payout will be decided after the selling of the crop and claims will be payable then.',
    ]},
    { heading: 'Policy Cover', paragraphs: [
      'The policy will cover field-to-floor, wind storms, hail Storms, barn fire and transit Risks.',
    ]},
    { heading: 'Insurance Period and Cancellation', paragraphs: [
      'The period commencing from the date of acceptance (subject to the delay period, where applicable), or crop emergence, whichever is the later, until the expiry date and as more specifically stated on the proposal form. Eligibility for this insurance shall be subject to the farmer duly completing a proposal form and having received acknowledgment from the Insurer. The Insurer shall not be liable to repay the premium or any part thereof if the insurance be terminated by the farmer before its expiry.',
    ]},
    { heading: 'Determination of Loss or Damage', paragraphs: [
      'No person, other than the farmer or his representative, may attend an assessment without the approval of the assessor(s). An assessment of any loss or damage may be deferred at the discretion of the assessor(s) until the extent of loss or damage can be determined. Assessments are only finally accepted when they have been received by the Insurer and found to be in order, provided that all assessments are subject to inspection and revision by assessor(s) instructed by the Insurer.',
    ]},
    { heading: 'Compulsory Excess', paragraphs: [
      'The farmer shall be responsible for the compulsory 15% excess of each loss incurred as related to the sum Insured as stated in the policy schedule in respect of each hectare lost or damaged.',
    ]},
    { heading: 'Cover for Replanted Crops', paragraphs: [
      'If the farmer replants an area after he has destroyed the original area on which a claim has already been made, then he must insure that total replanted area by completing a new application form and all terms and conditions.',
    ]},
    { heading: 'Exclusions', paragraphs: [
      'The Insurer will not be liable in respect of any claim for crop damage which is directly or indirectly caused by, arising from, contributed to by, connected with or resulting from any of the following:',
      '1. Damages or claims arising from arson, fraudulent activities',
      '2. Claims arising from war, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power.',
      '3. The actions of any Insured Person(s) and personal representatives contrary to the law, criminal or other acts of the law.',
      '4. Acts of God',
      '5. Loss of or damage to crops in seed beds',
      '6. Nonpayment of premium.',
      '7. If at the time of application for insurance the crop is not the farmer\u2019s bona fide property or there is no insurable interest',
      '8. If at the time of application for insurance the farmer has made a false statement in any manner regarding his crop.',
      '9. If the farmer fails or refuses to give all possible assistance in the investigation of any claim or fails to disclose any relevant information or otherwise makes a false or incorrect statement or declaration relating to the crop or an investigation concerned therewith.',
      '10. Loss or damage due to neglect, malpractice, or failure to follow established good farming practices.',
      '11. Loss or damage directly or indirectly due to drought, waterlogging, diseases, animals (domestic or wild), insects, and pests.',
      '12. Loss or damage due to failure of the farmer to harvest matured crops.',
      '13. Loss of or damage to any crop prior to the Insurer accepting the risk.',
      '14. Consequential loss or damage of any kind or description which include downgrading of the crop due to whatever cause.',
      '15. Loss or damage to the crop if the farmer fails to insure his total planted area.',
      '16. The compulsory excess as stated in the schedule',
    ]},
  ],
  exclusions: [
    'Damages or claims arising from arson, fraudulent activities',
    'Claims arising from war, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, labour disturbances, strikes or the activities of locked-out workers, rebellion, revolution insurrection or military or usurped power.',
    'The actions of any Insured Person(s) and personal representatives contrary to the law, criminal or other acts of the law.',
    'Acts of God',
    'Loss of or damage to crops in seed beds',
    'Nonpayment of premium.',
    'If at the time of application for insurance the crop is not the farmer\u2019s bona fide property or there is no insurable interest',
    'If at the time of application for insurance the farmer has made a false statement in any manner regarding his crop.',
    'If the farmer fails or refuses to give all possible assistance in the investigation of any claim or fails to disclose any relevant information or otherwise makes a false or incorrect statement or declaration relating to the crop or an investigation concerned therewith.',
    'Loss or damage due to neglect, malpractice, or failure to follow established good farming practices.',
    'Loss or damage directly or indirectly due to drought, waterlogging, diseases, animals (domestic or wild), insects, and pests.',
    'Loss or damage due to failure of the farmer to harvest matured crops.',
    'Loss of or damage to any crop prior to the Insurer accepting the risk.',
    'Consequential loss or damage of any kind or description which include downgrading of the crop due to whatever cause.',
    'Loss or damage to the crop if the farmer fails to insure his total planted area.',
    'The compulsory excess as stated in the schedule',
  ],
}

/** Fallback for products with no issued schedule of their own — labelled
 *  the product's own Policy Terms and Conditions, never "General
 *  Conditions", so the document reads as its own contract. */
const GENERAL: PolicyTerms = {
  productTitle: '',
  exclusionsHeading: 'Policy Terms and Conditions',
  exclusionsIntro: 'This policy is subject to the Policy Terms and Conditions of the Insurer. Without limiting those terms, cover under this policy is subject to the following:',
  exclusions: [
    'Claims occurring within the waiting period stated in the policy schedule, calculated from the commencement or reinstatement of the policy.',
    'Claims arising from a lapsed policy or a closed policy.',
    'War, invasion by a foreign country, acts of foreign enemies, hostilities (whether war is declared or not), civil war, rebellion, revolution, insurrection or military or usurped power.',
    'The actions of any Insured Person(s) or the Insured Person(s)\u2019 personal representatives contrary to the law, criminal or other acts of the law.',
    'Epidemics or pandemics as defined and declared by the World Health Organisation or the Zimbabwean health ministry.',
  ],
}

/** The terms document for ONE policy: its own product's Terms and
 *  Conditions, and only its own — there is no shared General Conditions
 *  section anymore. A product with no issued schedule of its own falls
 *  back to the generic policy terms so no document ships bare.
 *
 *  Field-to-Floor is the exception by design: its cover INCLUDES a flat
 *  $500 funeral benefit for the grower, so both schedules are part of
 *  the contract — tobacco terms AND the Funeral Cash Plan terms. */
export function termsPagesFor(product: { name?: string; category?: string }): PolicyTerms[] {
  const own = policyTermsFor(product)
  if (own === TOBACCO) return [TOBACCO, FUNERAL]
  return [own]
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
