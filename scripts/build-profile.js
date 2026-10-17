// Builds PROFILE.md: a plain-language allergy profile an AI can read
// alongside a restaurant menu. Run: node scripts/build-profile.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
const ingredients = read('data/ingredients.json');
const rules = read('data/rules.json');
const results = read('data/results.json').items;

const SYMPTOMS = {
  hives: 'hives', itching: 'itching', rash: 'rash', acne: 'acne / cysts', swelling: 'swelling',
  throat: 'throat tightness', breathing: 'trouble breathing', stomach: 'stomach pain',
  nausea: 'nausea / vomiting', diarrhea: 'diarrhea', bloating: 'bloating', headache: 'headache',
  anaphylaxis: 'anaphylaxis', brainfog: 'brain fog', anger: 'irritability / anger',
};
const byId = Object.fromEntries(ingredients.map((i) => [i.id, i]));
const status = (id) => results[id]?.status || null;
const severe = (id) => (results[id]?.symptoms || []).includes('anaphylaxis');
const avoid = (id) => ['reaction', 'intolerance'].includes(status(id));

function line(i) {
  const r = results[i.id] || {};
  const sx = (r.symptoms || []).filter((s) => s !== 'anaphylaxis').map((s) => SYMPTOMS[s] || s);
  const extra = [sx.length ? sx.join(', ') : '', r.note && r.note !== 'Confirmed allergen' ? r.note : ''].filter(Boolean).join('; ');
  return extra ? `${i.name} (${extra})` : i.name;
}

function byCategory(list) {
  const groups = new Map();
  for (const i of list) {
    if (!groups.has(i.category)) groups.set(i.category, []);
    groups.get(i.category).push(line(i));
  }
  return [...groups].map(([c, names]) => `- **${c}:** ${names.join(', ')}`).join('\n') || '- (none)';
}

const pick = (fn) => ingredients.filter(fn);
const anaphylaxis = pick((i) => avoid(i.id) && severe(i.id));
const reaction = pick((i) => status(i.id) === 'reaction' && !severe(i.id));
const intolerance = pick((i) => status(i.id) === 'intolerance' && !severe(i.id));
const untried = pick((i) => !status(i.id) || status(i.id) === 'untried');
const safe = pick((i) => status(i.id) === 'safe');

// Hidden-source rules that point at something to avoid.
const hidden = rules.rules
  .filter((r) => r.is.some((id) => id !== '?' && avoid(id)))
  .map((r) => {
    const targets = r.is.filter((id) => id !== '?').map((id) => byId[id].name);
    const how = r.any ? `could be ${targets.join(' / ')}${r.is.includes('?') ? ' / other' : ''}` : targets.join(' + ');
    return `- ${r.match.slice(0, 6).join(', ')}${r.match.length > 6 ? ', …' : ''} → ${how}${r.note ? ` (${r.note})` : ''}`;
  });
const vague = rules.rules.filter((r) => r.is.length === 1 && r.is[0] === '?')
  .map((r) => `- ${r.match.slice(0, 4).join(', ')}: ${r.note}`);

const updated = Math.max(0, ...Object.values(results).map((r) => r.updated || 0));

const md = `# Allergy profile

Generated from this repo's data by \`scripts/build-profile.js\`. Answers last changed ${updated ? new Date(updated).toISOString().slice(0, 10) : 'never'}.

## Instructions for an AI reading this

You are helping someone with severe food allergies decide what they can eat. When given a restaurant, menu, or product:

1. Sort every item into **Avoid**, **Ask first**, or **Likely safe**, and say which ingredient drove the call.
2. Anything in *Anaphylaxis*, *Reaction*, or *Intolerance* below is a hard **no**. Intolerances are not mild: they cause brain fog and anger.
3. For anaphylaxis allergens, cross-contact counts: shared fryers, griddles, toasters, and "may contain" warnings make an item **Avoid** unless the restaurant confirms otherwise.
4. Ingredients under *Not tried* or not listed anywhere are **Ask first**, not safe.
5. Menus rarely list everything. Assume restaurant cooking fats, sauces, dressings, batters, marinades, and seasoning blends may hide items below (butter on the griddle, egg wash, soybean or corn oil, cornstarch, dextrose, maltodextrin, yeast extract, natural flavors). When in doubt, **Ask first**.
6. For each **Ask first** item, write the exact question to ask the server.
7. Never mark something **Likely safe** based on guesses. Say what you couldn't confirm.

## Anaphylaxis (strict, including cross-contact)
${byCategory(anaphylaxis)}

## Reaction (avoid)
${byCategory(reaction)}

## Intolerance (avoid: brain fog, irritability)
${byCategory(intolerance)}

## Not tried yet (ask first)
${byCategory(untried)}

## Safe
${byCategory(safe)}

## Hidden sources of things to avoid
${hidden.join('\n') || '- (none)'}

## Vague ingredients (always ask)
${vague.join('\n')}

## Tags

Each ingredient in \`data/ingredients.json\` has tags (milk, egg, wheat, gluten, soy, corn, tree-nut, nightshade, legume, …). Full rules are in \`data/rules.json\`.
`;

fs.writeFileSync(path.join(root, 'PROFILE.md'), md);
console.log(`PROFILE.md: ${anaphylaxis.length} anaphylaxis, ${reaction.length} reaction, ${intolerance.length} intolerance, ${untried.length} untried, ${safe.length} safe`);
