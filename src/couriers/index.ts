import type { CourierAdapter } from '../types.js';
import { amazon } from './amazon.js';
import { bluedart } from './bluedart.js';
import { delhivery } from './delhivery.js';
import { dtdc } from './dtdc.js';
import { ecomexpress } from './ecomexpress.js';
import { ekart } from './ekart.js';
import { fedex } from './fedex.js';
import { goswift } from './goswift.js';
import { indiapost } from './indiapost.js';
import { shadowfax } from './shadowfax.js';
import { shiprocket } from './shiprocket.js';
import { xpressbees } from './xpressbees.js';

// Registration order matters for ambiguous numeric AWBs:
// specific / longer-pattern couriers come first.
export const ALL_COURIERS: CourierAdapter[] = [
  ekart,
  xpressbees,
  shadowfax,
  goswift,
  amazon,
  indiapost,
  fedex,
  dtdc,
  delhivery,
  ecomexpress,
  bluedart,
  shiprocket,
];

export const COURIER_BY_SLUG = new Map<string, CourierAdapter>(
  ALL_COURIERS.map((c) => [c.slug, c]),
);

// Aliases so users can pass common names/variants in the API
const ALIASES: Record<string, string> = {
  'blue-dart': 'bluedart',
  'blue dart': 'bluedart',
  'india-post': 'indiapost',
  'india post': 'indiapost',
  speedpost: 'indiapost',
  'speed-post': 'indiapost',
  'ecom-express': 'ecomexpress',
  'ecom express': 'ecomexpress',
  'xpress-bees': 'xpressbees',
  'go-swift': 'goswift',
  swift: 'goswift',
  'shadow-fax': 'shadowfax',
};

export function resolveCourierSlug(input: string): string {
  const lower = input.toLowerCase().trim();
  return ALIASES[lower] ?? lower;
}
