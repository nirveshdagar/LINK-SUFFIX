BEGIN;

ALTER TABLE tah_suffix_captures
  ADD COLUMN IF NOT EXISTS egress_identity jsonb;

COMMENT ON COLUMN tah_suffix_captures.egress_identity IS
  'Observed proxy egress and provider-estimated network/location metadata immutably associated with this suffix version.';

COMMIT;
