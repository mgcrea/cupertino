-- Captured from a real store by scripts/probe-safari.mjs --write.
-- macOS 26.6, fingerprint 1d20bcd2b9a5, 16 objects.
-- Schema only. No data.

CREATE TABLE history_client_versions (client_version INTEGER PRIMARY KEY,last_seen REAL NOT NULL);
CREATE TABLE history_event_listeners (listener_name TEXT PRIMARY KEY NOT NULL UNIQUE,last_seen REAL NOT NULL);
CREATE TABLE history_events (id INTEGER PRIMARY KEY AUTOINCREMENT,event_type TEXT NOT NULL,event_time REAL NOT NULL,pending_listeners TEXT NOT NULL,value BLOB);
CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,domain_expansion TEXT NULL,visit_count INTEGER NOT NULL,daily_visit_counts BLOB NOT NULL,weekly_visit_counts BLOB NULL,autocomplete_triggers BLOB NULL,should_recompute_derived_visit_counts INTEGER NOT NULL,visit_count_score INTEGER NOT NULL,status_code INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_items_to_tags (history_item INTEGER NOT NULL,tag_id INTEGER NOT NULL,timestamp REAL NOT NULL,FOREIGN KEY(tag_id) REFERENCES history_tags(id) ON DELETE CASCADE,FOREIGN KEY(history_item) REFERENCES history_items(id) ON DELETE CASCADE,UNIQUE(history_item, tag_id) ON CONFLICT REPLACE);
CREATE TABLE history_tags (id INTEGER PRIMARY KEY,type INTEGER NOT NULL,level INTEGER NOT NULL,identifier TEXT NOT NULL,title TEXT NOT NULL,modification_timestamp REAL NOT NULL,item_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT,start_time REAL NOT NULL,end_time REAL NOT NULL,url TEXT,generation INTEGER NOT NULL DEFAULT 0, udid TEXT, attributes INTEGER NOT NULL DEFAULT 0);
CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT,history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,visit_time REAL NOT NULL,title TEXT NULL,load_successful BOOLEAN NOT NULL DEFAULT 1,http_non_get BOOLEAN NOT NULL DEFAULT 0,synthesized BOOLEAN NOT NULL DEFAULT 0,redirect_source INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,redirect_destination INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,origin INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,attributes INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0);
CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value);
CREATE INDEX history_items__domain_expansion ON history_items (domain_expansion);
CREATE INDEX history_tombstones__end_time ON history_tombstones (end_time);
CREATE INDEX history_tombstones__generation ON history_tombstones (generation);
CREATE INDEX history_visits__last_visit ON history_visits (history_item, visit_time DESC, synthesized ASC);
CREATE INDEX history_visits__origin ON history_visits (origin, generation);
CREATE TRIGGER decrement_count_on_delete BEFORE DELETE ON history_items_to_tags BEGIN  UPDATE history_tags SET item_count = item_count - 1 WHERE id = OLD.tag_id;END;
CREATE TRIGGER increment_count_on_insert AFTER INSERT ON history_items_to_tags BEGIN  UPDATE history_tags SET item_count = item_count + 1 WHERE id = NEW.tag_id;END;
