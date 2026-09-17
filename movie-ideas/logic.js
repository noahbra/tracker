// Pure logic for the movie-idea slot machine: picking, building reel strips,
// the local fallback logline, and the Claude request/response shape. No DOM,
// no fetch, no storage; app.js wires those. Testable under node.

import { GENRES, CHARACTERS, STYLES } from './data.js';

export const REELS = [
  { key: 'genre', label: 'Genre', items: GENRES },
  { key: 'character', label: 'Character', items: CHARACTERS },
  { key: 'style', label: 'Style', items: STYLES },
];

export const MODEL = 'claude-opus-5';
export const API_URL = 'https://api.anthropic.com/v1/messages';

// ---------- picking ----------

export function pickOne(items, rng = Math.random, avoid) {
  if (!items.length) throw new Error('empty reel');
  if (items.length === 1) return items[0];
  let choice;
  do choice = items[Math.floor(rng() * items.length)];
  while (choice === avoid);
  return choice;
}

// One spin: a fresh value for every reel that is not held. Held reels keep
// their current value; a reel with nothing to keep is spun regardless.
export function spin(current = {}, held = {}, rng = Math.random) {
  const next = {};
  for (const reel of REELS) {
    const keep = held[reel.key] && current[reel.key];
    next[reel.key] = keep ? current[reel.key] : pickOne(reel.items, rng, current[reel.key]);
  }
  return next;
}

// The strip a reel scrolls through: starts with what is on screen now (so the
// motion is continuous), runs through `length` random entries, and lands on
// `target` with one more entry after it so the window below the winner is not
// blank. No two adjacent entries repeat.
export function buildStrip(items, visible, target, length, rng = Math.random) {
  const strip = visible.slice();
  while (strip.length < length - 2) strip.push(pickOne(items, rng, strip[strip.length - 1]));
  if (strip[strip.length - 1] === target) strip.pop();
  strip.push(target);
  strip.push(pickOne(items, rng, target));
  return strip;
}

// ---------- text ----------

export function withArticle(noun) {
  if (/^(the |a |an |two |army |Death |Time )/i.test(noun)) return noun;
  const first = noun.trim()[0];
  const vowel = /[aeiou]/i.test(first) && !/^uni/i.test(noun);
  return `${vowel ? 'an' : 'a'} ${noun}`;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// The house logline: what the app shows when no API key is set, or when the
// request fails. Assembled from templates so it lands instantly. Not as sharp
// as the model's, but always a complete, pitchable sentence.
const PREDICAMENTS = [
  'moves in with a roommate who has no idea what they are',
  'gets hired as the new manager of a failing family restaurant',
  'is forced to attend a high-school reunion in disguise',
  'has to plan a wedding in forty-eight hours',
  'wakes up as the last living thing on a cruise ship',
  'takes a job as a substitute teacher for one semester',
  'runs for mayor of a town that has never heard of them',
  'is the only witness to a crime nobody believes happened',
  'inherits a lighthouse and the debt that comes with it',
  'is put in charge of a daycare for the summer',
  'starts a podcast to prove they are innocent',
  'tries to return a defective product to a store that has closed',
  'joins a support group for the wrong problem',
  'becomes the getaway driver for a heist they thought was a carpool',
  'has ninety minutes to make a flight from the wrong airport',
  'is assigned a therapist who is worse off than they are',
  'has to babysit a child who can see through everything',
  'opens a food truck outside the one place it is illegal to park',
  'signs up for a dating show to win back an ex',
  'is deputized by accident and takes it seriously',
  'gets stuck in a customer-service phone tree for three days',
  'has to teach a night class on something they just learned',
  'is haunted by a very polite, very persistent stranger',
  'coaches a youth team that has never won a game',
  'tries to sell a house that keeps changing shape',
];

const TWISTS = [
  'the only person who can help is the one they wronged',
  'the whole thing is being filmed without their consent',
  'every mistake is broadcast live to a small but loyal audience',
  'the town has a rule against exactly this',
  'their body is not built for stairs',
  'they cannot lie, and everyone else can',
  'the deadline is real and so is the lawyer',
  'nobody else can see the problem',
  'the ex is now the boss',
  'the landlord is watching through the walls',
  'the audience keeps voting them back in',
  'the weather is on their side, and only the weather',
  'every clue points back to them',
  'the child is smarter than the plot',
  'their species has a very different idea of breakfast',
  'they have to do it in complete silence',
  'their rival is a slightly better version of themselves',
  'the ending has already been leaked',
  'the only ally speaks a language of pure gesture',
  'it all has to be done before the tide comes in',
];

export function houseLogline(pick, rng = Math.random) {
  const who = withArticle(pick.character);
  const predicament = pickOne(PREDICAMENTS, rng);
  const twist = pickOne(TWISTS, rng);
  const g = pick.genre.toLowerCase();
  const s = pick.style;
  const frames = [
    () => `A ${g}, shot as ${withArticle(s)}, in which ${who} ${predicament}, and ${twist}.`,
    () => `${capitalize(g)}, shot as ${withArticle(s)}: ${who} ${predicament}, but ${twist}.`,
    () => `In the style of ${withArticle(s)}, ${who} ${predicament}; the ${g} kicks in when ${twist}.`,
  ];
  return pickOne(frames, rng)();
}

export function houseTitle(pick, rng = Math.random) {
  const noun = capitalize(pick.character.replace(/^(the|a|an) /i, '').split(' ').slice(-1)[0]);
  const forms = [
    () => `${noun} Season`,
    () => `The ${noun} Problem`,
    () => `${noun}, Actually`,
    () => `Room for One ${noun}`,
    () => `A ${noun} Story`,
    () => `${capitalize(pick.genre.split(' ')[0])} ${noun}`,
  ];
  return pickOne(forms, rng)();
}

// ---------- Claude ----------

export const SYSTEM_PROMPT = `You write loglines for a movie-idea slot machine. Each spin gives three things: a familiar genre, a lead character that is hard to film in live action but easy to generate with AI video (creatures, machines, myths, talking objects), and a format or visual style. Your job is to turn them into one film idea a small filmmaker could actually make with AI video tools.

Reply in exactly two lines:
Line 1: a title of at most four words.
Line 2: one sentence, under 45 words, that reads like a pitch. Open with the format the way a pitch would ("A vlog-style short in which..."), name the character, make the premise concrete and specific, and land a hook. Prefer deadpan and specific over wacky and general. Ordinary human stakes with a strange lead beat spectacle.

No preamble, no quotes, no bullet points, nothing after line 2.

Example spin: Buddy comedy / mermaid / vlog
Example reply:
Roommate, Wet
A vlog-style short in which a man documents six months of splitting rent with a mermaid who insists the bathtub is a common area, delivered with complete deadpan.`;

export function buildRequest(pick) {
  return {
    model: MODEL,
    max_tokens: 400,
    fallbacks: 'default',
    output_config: { effort: 'low' },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Spin: ${pick.genre} / ${pick.character} / ${pick.style}\nReply with the title line and the logline line.`,
      },
    ],
  };
}

export function requestHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'server-side-fallback-2026-07-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

// Reads a Messages API response into { title, logline }. Throws on a refusal
// or an empty reply so the caller can fall back to the house logline.
export function parseResponse(res) {
  if (res.stop_reason === 'refusal') {
    const why = res.stop_details && res.stop_details.explanation;
    throw new Error(why ? `declined: ${why}` : 'declined by the model');
  }
  const text = (res.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('empty reply');
  const lines = text.split('\n').map((l) => l.replace(/^["'*\s]+|["'*\s]+$/g, '')).filter(Boolean);
  if (lines.length === 1) return { title: '', logline: lines[0] };
  return { title: lines[0], logline: lines.slice(1).join(' ') };
}
