# The Solution to Allergies

A personal allergy dashboard. Step one: **Allergy Swipe**, a Tinder-style deck of base ingredients.

| Swipe | Means |
|---|---|
| ← Left | Reaction (hives, itching, anaphylaxis…) |
| → Right | Safe |
| ↑ Up | Intolerance (stomach, bloating…) |
| ↓ Down | Haven't tried / not sure |

Arrow keys work on desktop. After a reaction or intolerance you can tag symptoms and add a note. Everything is editable later in **My list**.

## Data

- `data/ingredients.json`: base ingredients with a category and tags (`milk`, `tree-nut`, `gluten`, `nightshade`, …). Tags let recipes and products be checked against your results later.
- `data/results.json`: your answers. Dairy, sesame, and fish start pre-marked as reactions.

## Setup

1. **GitHub Pages:** repo Settings → Pages → Source: *Deploy from a branch* → `main` / `(root)`.
2. **Saving to the repo:** create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with access to only this repo and *Contents: Read and write*. Paste it into the app's Settings tab. Changes commit to `data/results.json` a few seconds after you stop swiping.

Without a token, answers are kept in your browser only (use Export to back them up).
