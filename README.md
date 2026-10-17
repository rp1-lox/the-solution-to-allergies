# The Solution to Allergies

A personal allergy dashboard. Step one: **Allergy Swipe**, a Tinder-style deck of base ingredients.

| Swipe | Means |
|---|---|
| ← Left | Reaction (hives, itching, anaphylaxis…) |
| → Right | Safe |
| ↑ Up | Intolerance (stomach, bloating…) |
| ↓ Down | Haven't tried / not sure |

Arrow keys work on desktop. After a reaction or intolerance you can tag symptoms and add a note. Everything is editable later in **My list**.

## Check

Scan a barcode (looked up in [Open Food Facts](https://world.openfoodfacts.org)) or paste an ingredient list. Each ingredient is matched against your answers:

- **No**: contains something you marked reaction or intolerance.
- **Caution**: has ingredients you haven't tried, vague ones ("natural flavors", "vegetable oil"), or a "may contain" warning for something you avoid.
- **Looks safe**: everything is on your safe list.

Hidden sources are handled by `data/rules.json` (e.g. dextrose → usually corn, powdered sugar → contains cornstarch, cocoa butter → not dairy).

## Restaurants and menus

`PROFILE.md` is a plain-language summary of your answers plus instructions for an AI. It rebuilds automatically (GitHub Action) whenever your answers change. To check a menu, give an AI the restaurant's menu link and this link:

https://github.com/rp1-lox/the-solution-to-allergies/blob/main/PROFILE.md

and ask: "Using my allergy profile, what can I eat here?"

## Data

- `data/ingredients.json`: base ingredients with a category and tags (`milk`, `tree-nut`, `gluten`, `nightshade`, …). Tags let recipes and products be checked against your results later.
- `data/rules.json`: synonyms, hidden sources, and vague ingredients, mapped to ingredient ids.
- `data/results.json`: your answers. Dairy, sesame, and fish start pre-marked as reactions.

## Setup

1. **GitHub Pages:** repo Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
2. **Saving to the repo:** create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to only this repo and *Contents: Read and write*. Paste it into the app's Settings tab. Changes commit to `data/results.json` a few seconds after you stop swiping.

Without a token, answers are kept in your browser only (use Export to back them up).
