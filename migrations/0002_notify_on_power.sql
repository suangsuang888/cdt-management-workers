-- 0002: new notification category for manual / window power on-off
-- notices. Existing installs only have the 0001 seed rows, so insert the
-- new default here; fresh installs get it from 0001 as well.
INSERT INTO settings(key, value) VALUES('notify_on_power', '1') ON CONFLICT(key) DO NOTHING;
