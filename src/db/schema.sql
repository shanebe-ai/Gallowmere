-- Gallowmere schema. Safe to run on every deploy.

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  district    TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  flags       TEXT[] NOT NULL DEFAULT '{}'
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS exits (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL,
  to_room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  hidden     BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (room_id, direction)
);

CREATE TABLE IF NOT EXISTS players (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS players_name_lower ON players (lower(name));

CREATE TABLE IF NOT EXISTS player_aliases (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  alias     TEXT NOT NULL,
  expansion TEXT NOT NULL,
  PRIMARY KEY (player_id, alias)
);

CREATE TABLE IF NOT EXISTS npcs (
  id        TEXT PRIMARY KEY,
  room_id   TEXT NOT NULL REFERENCES rooms(id),
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('ai', 'scripted')),
  card_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS npc_memory (
  npc_id     TEXT NOT NULL REFERENCES npcs(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  notes      TEXT[] NOT NULL DEFAULT '{}',
  summary    TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (npc_id, player_id)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id            BIGSERIAL PRIMARY KEY,
  player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  npc_id        TEXT,
  provider      TEXT NOT NULL,
  model         TEXT,
  tokens_in     INTEGER NOT NULL DEFAULT 0,
  tokens_out    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER NOT NULL DEFAULT 0,
  fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_usage_player_time ON ai_usage (player_id, created_at);

-- Lines caught by the content filter, for admin review.
CREATE TABLE IF NOT EXISTS flagged_lines (
  id         BIGSERIAL PRIMARY KEY,
  player_id  INTEGER REFERENCES players(id) ON DELETE SET NULL,
  source     TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Milestone 2: coin, items, shops, standing.

ALTER TABLE players ADD COLUMN IF NOT EXISTS coin INTEGER NOT NULL DEFAULT 10 CHECK (coin >= 0);
ALTER TABLE players ADD COLUMN IF NOT EXISTS bank_coin INTEGER NOT NULL DEFAULT 0 CHECK (bank_coin >= 0);
ALTER TABLE npc_memory ADD COLUMN IF NOT EXISTS standing INTEGER NOT NULL DEFAULT 0 CHECK (standing BETWEEN -5 AND 5);

CREATE TABLE IF NOT EXISTS item_templates (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  keywords   TEXT[] NOT NULL,
  kind       TEXT NOT NULL,
  weight     INTEGER NOT NULL,
  price      INTEGER NOT NULL,
  card_json  JSONB NOT NULL
);

-- Every real item. owner_type: player, room or shop. owner_id: player id, room id or npc id.
CREATE TABLE IF NOT EXISTS items (
  id          BIGSERIAL PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES item_templates(id),
  owner_type  TEXT NOT NULL CHECK (owner_type IN ('player', 'room', 'shop')),
  owner_id    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS items_owner ON items (owner_type, owner_id);

CREATE TABLE IF NOT EXISTS shops (
  npc_id      TEXT PRIMARY KEY,
  purse       INTEGER NOT NULL DEFAULT 0 CHECK (purse >= 0),
  purse_day   DATE NOT NULL DEFAULT CURRENT_DATE
);

-- Every coin movement, for audit and to catch duplication.
CREATE TABLE IF NOT EXISTS coin_ledger (
  id            BIGSERIAL PRIMARY KEY,
  player_id     INTEGER REFERENCES players(id) ON DELETE SET NULL,
  change        INTEGER NOT NULL,
  bank_change   INTEGER NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL,
  balance_after INTEGER NOT NULL,
  bank_after    INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coin_ledger_player ON coin_ledger (player_id, created_at);

-- Scavenging cooldowns, one row per player per spot.
CREATE TABLE IF NOT EXISTS scavenges (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  spot      TEXT NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, spot)
);

-- Once a day standing bumps and odd job cooldowns.
CREATE TABLE IF NOT EXISTS player_flags (
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  flag      TEXT NOT NULL,
  value     TEXT NOT NULL DEFAULT '',
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, flag)
);
