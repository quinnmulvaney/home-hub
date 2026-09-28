// Merchant matching for "always categorize this merchant" rules.
// merchantKey and the prefix matching must stay in sync with sync/bank_sync.py.

const GENERIC_WORDS = new Set(['the', 'payment', 'online', 'purchase', 'pos', 'debit', 'credit', 'card', 'ach', 'check',
  'deposit', 'withdrawal', 'transfer', 'recurring', 'web', 'www', 'com', 'inc', 'llc', 'store']);

export function merchantKey(text) {
  let s = String(text || '').toLowerCase();
  s = s.replace(/^(sq \*|sq\*|tst\* ?|sp \*?|pp\*|paypal \*|dd \*|in \*)/, '');
  s = s.replace(/[^a-z ]+/g, ' ');
  return s.split(/\s+/).filter((w) => w.length > 1).slice(0, 3).join(' ');
}

// Default rule text: just the brand when the first word is distinctive ("sheetz"), else two words ("home depot").
export function suggestRule(text) {
  const words = merchantKey(text).split(' ').filter(Boolean);
  if (!words.length) return '';
  return words[0].length >= 5 && !GENERIC_WORDS.has(words[0]) ? words[0] : words.slice(0, 2).join(' ');
}

// A rule matches a merchant when it's the merchant key or a whole-word prefix of it.
export function ruleMatches(rule, text) {
  const key = merchantKey(text);
  return !!rule && (key === rule || key.startsWith(`${rule} `));
}
