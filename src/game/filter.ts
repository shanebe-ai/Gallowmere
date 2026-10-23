// Simple word list content filter for player and NPC text.
// The list is base64 encoded so the repo doesn't read like a slur dictionary.
// Add entries with: Buffer.from('word').toString('base64')

const ENCODED = [
  'bmlnZ2Vy', 'bmlnZ2E=', 'ZmFnZ290', 'ZmFn', 'cmV0YXJk', 'a2lrZQ==', 'c3BpYw==',
  'Y2hpbms=', 'dHJhbm55', 'd2V0YmFjaw==', 'Z29vaw==', 'Y29vbg==', 'cmFwZQ==', 'cGVkbw==',
];

const WORDS = ENCODED.map((w) => Buffer.from(w, 'base64').toString('utf8'));
const PATTERN = new RegExp(`\\b(${WORDS.join('|')})(s|z|ed|ing)?\\b`, 'i');

export function isFlagged(text: string): boolean {
  // Collapse common evasions: repeated letters, digits for letters, separators.
  const normal = text
    .toLowerCase()
    .replace(/[0]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/[3]/g, 'e')
    .replace(/[4@]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/(.)\1{2,}/g, '$1$1');
  return PATTERN.test(text) || PATTERN.test(normal);
}
