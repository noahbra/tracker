// Run: node tests/movie.test.mjs
// Pure-logic coverage for the movie-idea slot machine (movie-ideas/logic.js).

import * as M from '../movie-ideas/logic.js';

let fails = 0;
function check(name, ok, detail) {
  if (ok) console.log(`ok   ${name}`);
  else { fails++; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// Deterministic rng from a seed, so assertions about randomness are stable.
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Reels are populated and have no duplicates.
for (const reel of M.REELS) {
  check(`${reel.key} reel has plenty of entries`, reel.items.length >= 100, String(reel.items.length));
  const dupes = reel.items.filter((x, i) => reel.items.indexOf(x) !== i);
  check(`${reel.key} reel has no duplicates`, dupes.length === 0, dupes.join(', '));
}

// spin gives every reel a value; held reels keep theirs; unheld reels change.
{
  const rng = seeded(7);
  const first = M.spin({}, {}, rng);
  check('spin fills every reel', M.REELS.every((r) => typeof first[r.key] === 'string' && first[r.key]));
  const second = M.spin(first, { character: true }, rng);
  check('held reel keeps its value', second.character === first.character);
  check('unheld reel changes on the next spin', second.genre !== first.genre && second.style !== first.style);
  const alone = M.spin({}, { genre: true }, rng);
  check('holding an empty reel still spins it', typeof alone.genre === 'string' && alone.genre);
}

// buildStrip keeps the visible entries first, lands on the target second to
// last, and never repeats an entry back to back.
{
  const rng = seeded(11);
  const items = M.REELS[0].items;
  const visible = [items[0], items[1], items[2]];
  const target = items[50];
  const strip = M.buildStrip(items, visible, target, 30, rng);
  check('strip starts with what is on screen', strip.slice(0, 3).join('|') === visible.join('|'));
  check('strip lands on the target second to last', strip[strip.length - 2] === target);
  check('strip has one entry below the target', strip.length === 30 && strip[strip.length - 1] !== target);
  const adjacent = strip.some((x, i) => i > 0 && x === strip[i - 1]);
  check('strip has no adjacent repeats', !adjacent);
}

// Articles.
check('article: consonant', M.withArticle('mermaid') === 'a mermaid');
check('article: vowel', M.withArticle('alien diplomat') === 'an alien diplomat');
check('article: unicorn takes "a"', M.withArticle('unicorn') === 'a unicorn');
check('article: proper name kept', M.withArticle('the Grim Reaper') === 'the Grim Reaper');
check('article: personified kept', M.withArticle('Death personified') === 'Death personified');

// House logline is a full sentence naming all three picks.
{
  const rng = seeded(3);
  const pick = { genre: 'Buddy comedy', character: 'mermaid', style: 'vlog' };
  const line = M.houseLogline(pick, rng);
  check('house logline is one sentence', /^[A-Z].*[.]$/.test(line), line);
  check('house logline mentions the character', line.includes('mermaid'), line);
  check('house logline mentions the style', line.includes('vlog'), line);
  check('house logline mentions the genre', line.toLowerCase().includes('buddy comedy'), line);
  const title = M.houseTitle(pick, rng);
  check('house title is short', title.split(' ').length <= 4, title);
}

// Request shape.
{
  const req = M.buildRequest({ genre: 'Heist', character: 'ghost', style: 'mockumentary' });
  check('request uses the default model', req.model === M.MODEL);
  check('request opts into server-side fallbacks', req.fallbacks === 'default');
  check('request names all three picks', req.messages[0].content.includes('Heist / ghost / mockumentary'));
  const h = M.requestHeaders('sk-test');
  const prompt = M.buildPrompt({ genre: 'Heist', character: 'ghost', style: 'mockumentary' });
  check('single-string prompt carries the instructions and the spin', prompt.startsWith(M.SYSTEM_PROMPT) && prompt.includes('Heist / ghost / mockumentary'));
  const t = M.parseText('  Ghost Job\nA mockumentary in which a ghost robs a bank.  ');
  check('parseText splits title and logline', t.title === 'Ghost Job' && t.logline === 'A mockumentary in which a ghost robs a bank.');
  check('headers allow direct browser access', h['anthropic-dangerous-direct-browser-access'] === 'true');
  check('headers carry the fallback beta', h['anthropic-beta'] === 'server-side-fallback-2026-07-01');
}

// Response parsing.
{
  const good = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Roommate, Wet\nA vlog-style short in which a man rooms with a mermaid.' }] };
  const parsed = M.parseResponse(good);
  check('parses title line', parsed.title === 'Roommate, Wet', parsed.title);
  check('parses logline line', parsed.logline.startsWith('A vlog-style short'), parsed.logline);
  const quoted = { stop_reason: 'end_turn', content: [{ type: 'text', text: '"Only Logline"' }] };
  check('single line becomes the logline', M.parseResponse(quoted).logline === 'Only Logline');
  let threw = false;
  try { M.parseResponse({ stop_reason: 'refusal', stop_details: { explanation: 'nope' }, content: [] }); } catch (e) { threw = /declined/.test(e.message); }
  check('refusal throws', threw);
  threw = false;
  try { M.parseResponse({ stop_reason: 'end_turn', content: [] }); } catch (e) { threw = true; }
  check('empty reply throws', threw);
}

console.log(fails ? `\n${fails} failing` : '\nall passing');
process.exit(fails ? 1 : 0);
