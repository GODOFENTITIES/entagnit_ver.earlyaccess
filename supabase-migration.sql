-- =============================================================================
-- Potspark × Veloxwale — Game Chat Schema Migration
-- Run this in: Supabase Dashboard → SQL Editor
--
-- This migration creates three new tables alongside the existing Veloxwale
-- tables (profiles, personas, messages, friendships). Nothing is modified or
-- deleted — this is a pure addition.
--
-- Tables: game_channels, game_channel_members, game_messages
-- RLS:    ON for all three tables from day one.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. game_channels
--    One row per logical chat channel (lobby:global, room:ABCD12, etc.)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_channels (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  channel_key  text        NOT NULL,          -- e.g. "lobby:global", "room:ABCD12"
  channel_type text        NOT NULL           -- 'lobby' | 'room' | 'match' | 'dm'
                           CHECK (channel_type IN ('lobby', 'room', 'match', 'dm')),
  is_archived  boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_channels_pkey PRIMARY KEY (id),
  CONSTRAINT game_channels_channel_key_key UNIQUE (channel_key)
);

-- Index for the REST API lookup by channel_key (used by chatBridge).
CREATE INDEX IF NOT EXISTS game_channels_key_idx ON public.game_channels (channel_key);

-- Enable RLS immediately — no data is readable until policies are added below.
ALTER TABLE public.game_channels ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. game_channel_members
--    Server-managed junction: which Supabase UIDs belong to which channel.
--    The Potspark Node server INSERT/DELETEs here using the service-role key.
--    The browser can only SELECT its own row.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_channel_members (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  channel_id   uuid        NOT NULL REFERENCES public.game_channels (id) ON DELETE CASCADE,
  supabase_uid uuid        NOT NULL,          -- auth.uid() of the member
  joined_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_channel_members_pkey PRIMARY KEY (id),
  CONSTRAINT game_channel_members_unique UNIQUE (channel_id, supabase_uid)
);

CREATE INDEX IF NOT EXISTS game_channel_members_uid_idx
  ON public.game_channel_members (supabase_uid);

CREATE INDEX IF NOT EXISTS game_channel_members_channel_idx
  ON public.game_channel_members (channel_id);

ALTER TABLE public.game_channel_members ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. game_messages
--    One row per chat message. Uses a separate table from the existing
--    AI-persona `messages` table — the sender CHECK constraint on that table
--    ('USER' | 'AI') makes it incompatible with game chat senders.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.game_messages (
  id           uuid        NOT NULL DEFAULT gen_random_uuid(),
  channel_id   uuid        NOT NULL REFERENCES public.game_channels (id) ON DELETE CASCADE,
  sender_uid   uuid        NOT NULL,          -- auth.uid() of the sender (= supabase_uid)
  username     text        NOT NULL,          -- display name at time of send (denormalized for speed)
  body         text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 280),
  inserted_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_messages_pkey PRIMARY KEY (id)
);

-- index for efficient history fetch (newest first per channel)
CREATE INDEX IF NOT EXISTS game_messages_channel_time_idx
  ON public.game_messages (channel_id, inserted_at DESC);

ALTER TABLE public.game_messages ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- RLS Policies
-- =============================================================================

-- ---------------------------------------------------------------------------
-- game_channels: users can only see channels they are a member of.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "channel member can view channel" ON public.game_channels;
CREATE POLICY "channel member can view channel"
  ON public.game_channels
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.game_channel_members gcm
      WHERE gcm.channel_id = game_channels.id
        AND gcm.supabase_uid = auth.uid()
    )
  );

-- No INSERT/UPDATE/DELETE from the browser — those go through the service-role key.

-- ---------------------------------------------------------------------------
-- game_channel_members: users can see their own membership rows only.
-- INSERT/DELETE is service-role only (no browser policy needed).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "member can view own membership" ON public.game_channel_members;
CREATE POLICY "member can view own membership"
  ON public.game_channel_members
  FOR SELECT
  USING (supabase_uid = auth.uid());

-- ---------------------------------------------------------------------------
-- game_messages SELECT: only members of the channel can read messages.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "channel member can read messages" ON public.game_messages;
CREATE POLICY "channel member can read messages"
  ON public.game_messages
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.game_channel_members gcm
      WHERE gcm.channel_id = game_messages.channel_id
        AND gcm.supabase_uid = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- game_messages INSERT: senders can only post as themselves, body ≤ 280 chars,
-- and only into channels they are a member of.
-- (The char_length CHECK constraint on the column doubles as the DB-level guard.)
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "member can insert own messages" ON public.game_messages;
CREATE POLICY "member can insert own messages"
  ON public.game_messages
  FOR INSERT
  WITH CHECK (
    sender_uid = auth.uid()
    AND char_length(body) BETWEEN 1 AND 280
    AND EXISTS (
      SELECT 1 FROM public.game_channel_members gcm
      WHERE gcm.channel_id = game_messages.channel_id
        AND gcm.supabase_uid = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.game_channels gc
      WHERE gc.id = game_messages.channel_id
        AND gc.is_archived = false
    )
  );

-- No UPDATE or DELETE from the browser — messages are immutable once sent.

-- =============================================================================
-- Realtime publication
-- Enables the Supabase Realtime engine to stream new game_messages rows to
-- subscribed browser clients. Run this ONCE — re-running is a no-op.
-- =============================================================================

-- If not already added:
ALTER PUBLICATION supabase_realtime ADD TABLE public.game_messages;

-- =============================================================================
-- Seed: create the lobby:global channel so it exists on startup.
-- The Potspark server also calls _ensureLobbyChannel() on boot, but having the
-- row pre-seeded means chat works even before the first server start.
-- =============================================================================

INSERT INTO public.game_channels (channel_key, channel_type, is_archived)
VALUES ('lobby:global', 'lobby', false)
ON CONFLICT (channel_key) DO NOTHING;
