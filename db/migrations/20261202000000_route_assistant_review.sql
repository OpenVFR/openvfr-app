-- migrate:up

-- A saved route can carry an "assistant review" mark, like aircraft profiles
-- (whose mark lives inside their `data` JSON): set when the pilot's AI
-- assistant created or changed the route through the assistant connection,
-- cleared (NULL) when the pilot saves the route in the app. The apps show
-- "check before use" while it is set.
--
-- Clients send the column only when they clear a mark, so older apps and
-- newer apps against a server without this migration keep syncing.

ALTER TABLE user_routes ADD COLUMN IF NOT EXISTS assistant_review JSONB;

COMMENT ON COLUMN user_routes.assistant_review IS
  'Set by the assistant connection: {by, at, change: "created" | [fields]}; NULL once the pilot saved the route in the app.';

ALTER TABLE user_routes DROP CONSTRAINT IF EXISTS user_routes_review_size_chk;
ALTER TABLE user_routes ADD CONSTRAINT user_routes_review_size_chk CHECK (
  assistant_review IS NULL OR octet_length(assistant_review::text) <= 4096
) NOT VALID;

NOTIFY pgrst, 'reload schema';

-- migrate:down

ALTER TABLE user_routes DROP CONSTRAINT IF EXISTS user_routes_review_size_chk;
ALTER TABLE user_routes DROP COLUMN IF EXISTS assistant_review;

NOTIFY pgrst, 'reload schema';
