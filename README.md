# Gallowmere

A small dark fantasy text MUD played in the browser. One grim walled river town, and the townsfolk remember you.

This is a proof of concept. The idea: game code owns every rule, and an LLM only supplies the words. The barkeep can chat, remember you between visits and decide she's done talking to you, but she can't hand out gold, items or anything else, because only code moves those.

## Milestone 1: Walk the town

* 15 rooms, look, move, say, emote, who, aliases, help
* Character creation and login
* Morda, the barkeep of The Drowned Rat, played by an LLM with per player memory stored in PostgreSQL
* Scripted townsfolk for flavour (gate guard, blacksmith, beggar, rats)
* Browser terminal built on xterm.js: colour, scrollback, command history, clickable exits, exit buttons, reconnect, works on phones

## How the NPC brain works

1. Player talks to Morda.
2. The brain builds a prompt: her character card, what she remembers about this player, the room, the last few lines, and the short list of allowed actions (`none`, `remember`, `refuse`).
3. Player text only ever goes in the user message, never the system prompt.
4. The model replies with JSON: one line of speech, an optional emote, one action.
5. The engine validates everything. Unknown actions become `none`. Lengths are capped, escape codes stripped, a word filter checks the text.
6. Groq (Llama 3.1 8B) first, Gemini Flash Lite if Groq is slow, rate limited or down, and scripted lines if both are out. The game never goes silent.

Every NPC line is logged to `ai_usage`. Admins can type `aistats` in game to see lines per player per hour, latency, fallback rate and token counts.

## Stack

Node, TypeScript, Express, Socket.io, PostgreSQL 16, xterm.js. Provider adapter adapted from LetsMCP. Deployed with pm2 and GitHub Actions.

## Running locally

```
npm ci
cp .env.example .env    # fill in the DB settings, AI keys optional
npm run db:migrate
npm run dev             # http://localhost:3004
npm test                # needs a gallowmere_test database
```

## First time server setup

Server 1 runs it from `/home/gallowmere` on port 3004. One time steps:

1. Create the database user and database in PostgreSQL.
2. Clone the repo into `/home/gallowmere`.
3. Copy `.env.example` to `.env` and fill in the DB password, `GROQ_API_KEY` and `GEMINI_API_KEY` (both free tier).
4. Add `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_KEY` to the repo's Actions secrets, same values as the other projects.
5. Push to main. The deploy workflow builds, migrates, starts the `gallowmere` pm2 process and checks `/health`.
6. Run `pm2 save` once so it comes back after a reboot.

## What's next

Milestone 2 brings the full market: 40 rooms, six AI NPCs, haggling inside code set price ranges and a bank.
