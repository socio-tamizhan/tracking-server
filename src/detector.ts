// Patterns are ordered: most-specific (unique prefix) first, ambiguous numeric last.
// High-confidence = unique prefix; medium = length-based; low = broad overlap.
const RULES: { slug: string; pattern: RegExp; confidence: 'high' | 'medium' | 'low' }[] = [
  // Unique alphabetic prefixes — high confidence
  { slug: 'ekart',       pattern: /^FMPC\d{10}$/i,          confidence: 'high' },
  { slug: 'ekart',       pattern: /^KS\d{9,11}$/i,           confidence: 'high' },
  { slug: 'xpressbees',  pattern: /^XB\d{11,14}$/i,          confidence: 'high' },
  { slug: 'shadowfax',   pattern: /^SFX\d{8,}$/i,            confidence: 'high' },
  { slug: 'shadowfax',   pattern: /^SX\d{10,}$/i,            confidence: 'high' },
  { slug: 'goswift',     pattern: /^GS[A-Z0-9]{8,14}$/i,     confidence: 'high' },
  { slug: 'amazon',      pattern: /^ZX[0-9A-Z]{10,15}$/i,    confidence: 'high' },
  { slug: 'indiapost',   pattern: /^[A-Z]{2}\d{9}(IN|[A-Z]{2})$/i, confidence: 'high' },
  { slug: 'fedex',       pattern: /^JD\d{18}$/,              confidence: 'high' },

  // DTDC prefix patterns
  { slug: 'dtdc',        pattern: /^[ZDABM]\d{7,11}$/,       confidence: 'medium' },

  // FedEx numeric lengths (unique lengths)
  { slug: 'fedex',       pattern: /^\d{15}$/,                confidence: 'medium' },
  { slug: 'fedex',       pattern: /^\d{20,22}$/,             confidence: 'medium' },

  // Delhivery — long numeric AWBs
  { slug: 'delhivery',   pattern: /^\d{16,22}$/,             confidence: 'medium' },
  { slug: 'delhivery',   pattern: /^[A-Z]{3}\d{12,}$/i,      confidence: 'medium' },

  // Ecom Express — exactly 10 digits
  { slug: 'ecomexpress', pattern: /^\d{10}$/,                confidence: 'low' },

  // Bluedart — 8-11 digit numeric (overlaps with others)
  { slug: 'bluedart',    pattern: /^\d{8,11}$/,              confidence: 'low' },

  // FedEx 12-digit overlaps with other couriers
  { slug: 'fedex',       pattern: /^\d{12}$/,                confidence: 'low' },
];

export interface DetectionResult {
  slug: string;
  confidence: 'high' | 'medium' | 'low';
}

export function detectCourier(awb: string): DetectionResult[] {
  const normalized = awb.trim().toUpperCase();
  const matches: DetectionResult[] = [];
  const seen = new Set<string>();

  for (const rule of RULES) {
    if (rule.pattern.test(normalized) && !seen.has(rule.slug)) {
      matches.push({ slug: rule.slug, confidence: rule.confidence });
      seen.add(rule.slug);
    }
  }

  return matches;
}

export function isAmbiguous(matches: DetectionResult[]): boolean {
  return matches.length > 1 && matches[0].confidence !== 'high';
}
