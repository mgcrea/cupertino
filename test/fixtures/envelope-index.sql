-- Captured from a real Envelope Index by scripts/probe-envelope-index.mjs.
-- macOS 26.6, Mail V10, fingerprint 77aa2cd3a55b.
-- Schema only. No data.

CREATE TABLE action_flags (ROWID INTEGER PRIMARY KEY,
action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
flag_type INTEGER,
flag_value INTEGER);
CREATE TABLE action_labels (ROWID INTEGER PRIMARY KEY,
action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
do_add INTEGER,
label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE);
CREATE TABLE action_messages (ROWID INTEGER PRIMARY KEY,
action INTEGER REFERENCES local_message_actions(ROWID) ON DELETE CASCADE,
action_phase INTEGER,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
remote_id INTEGER,
destination_message INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE);
CREATE TABLE additional_remote_content_links (ROWID INTEGER PRIMARY KEY,
url TEXT COLLATE BINARY NOT NULL,
requests INTEGER NOT NULL DEFAULT 0,
last_seen_date INTEGER NOT NULL,
last_request_date INTEGER NOT NULL DEFAULT 0,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE address_metadata (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
smime_capabilities TEXT COLLATE NOCASE NOT NULL,
smime_capabilities_date INTEGER NOT NULL,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address TEXT COLLATE NOCASE NOT NULL,
comment TEXT COLLATE BINARY NOT NULL,
UNIQUE(address, comment) ON CONFLICT ABORT);
CREATE TABLE attachments (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
attachment_id TEXT COLLATE BINARY,
name TEXT COLLATE BINARY,
UNIQUE(message, attachment_id) ON CONFLICT ABORT);
CREATE TABLE brand_indicator_evidence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
brand_indicator INTEGER NOT NULL REFERENCES brand_indicators(ROWID) ON DELETE CASCADE ON UPDATE CASCADE,
url TEXT COLLATE BINARY NOT NULL,
evidence BLOB,
unverified_messages TEXT COLLATE BINARY,
UNIQUE(brand_indicator, url) ON CONFLICT ABORT);
CREATE TABLE brand_indicators (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
indicator BLOB,
indicator_hash TEXT COLLATE BINARY,
hash_algorithm TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE business_addresses (ROWID INTEGER PRIMARY KEY,
address INTEGER NOT NULL,
business INTEGER NOT NULL,
category INTEGER,
last_modified INTEGER,
last_bcs_sync INTEGER,
UNIQUE(address) ON CONFLICT ABORT);
CREATE TABLE business_categories (ROWID INTEGER PRIMARY KEY,
business INTEGER NOT NULL,
category INTEGER NOT NULL,
UNIQUE(business) ON CONFLICT ABORT);
CREATE TABLE businesses (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
address_comment TEXT COLLATE NOCASE,
domain TEXT COLLATE NOCASE,
brand_id INTEGER,
localized_brand_name TEXT,
UNIQUE(address_comment, domain) ON CONFLICT ABORT,
UNIQUE(brand_id) ON CONFLICT ABORT,
CHECK(((address_comment IS NOT NULL AND domain IS NOT NULL AND brand_id IS NULL AND localized_brand_name IS NULL) OR (address_comment IS NULL AND domain IS NULL AND brand_id IS NOT NULL AND localized_brand_name IS NOT NULL))));
CREATE TABLE conversation_id_message_id (conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE ON UPDATE CASCADE,
message_id INTEGER NOT NULL DEFAULT 0,
date_sent INTEGER NOT NULL DEFAULT 0,
PRIMARY KEY(conversation_id, message_id)) WITHOUT ROWID;
CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
flags INTEGER NOT NULL DEFAULT 0,
sync_key TEXT COLLATE BINARY);
CREATE TABLE data_detection_results (ROWID INTEGER PRIMARY KEY,
global_message_id INTEGER NOT NULL,
category TEXT COLLATE BINARY NOT NULL,
value TEXT COLLATE BINARY NOT NULL,
UNIQUE(global_message_id, category, value) ON CONFLICT ABORT);
CREATE TABLE duplicates_unread_count (ROWID INTEGER PRIMARY KEY, message_id INTEGER NOT NULL, mailbox_id INTEGER NOT NULL REFERENCES mailboxes(ROWID) ON DELETE CASCADE, unread_count INTEGER DEFAULT 0, UNIQUE(message_id, mailbox_id));
CREATE TABLE events (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE, start_date INTEGER, end_date INTEGER, location TEXT, out_of_date INTEGER DEFAULT 0, processed INTEGER DEFAULT 0, is_all_day INTEGER DEFAULT 0, associated_id_string TEXT, original_receiving_account TEXT, ical_uid TEXT, is_response_requested INTEGER DEFAULT 0);
CREATE TABLE ews_folders (ROWID INTEGER PRIMARY KEY, folder_id TEXT UNIQUE ON CONFLICT REPLACE, mailbox_id INTEGER NOT NULL UNIQUE ON CONFLICT REPLACE REFERENCES mailboxes(ROWID) ON DELETE CASCADE, sync_state TEXT);
CREATE TABLE generated_summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary BLOB NOT NULL,
status INTEGER NOT NULL DEFAULT 0);
CREATE TABLE indexing_analytics_attachment_donations_enqueued (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
source INTEGER NOT NULL,
started_at REAL NOT NULL,
ended_at REAL,
error INTEGER);
CREATE TABLE indexing_analytics_attachment_donations_identified (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
reason INTEGER NOT NULL,
started_at REAL NOT NULL,
recorded INTEGER NOT NULL,
ended_at REAL);
CREATE TABLE indexing_analytics_batches (id INTEGER PRIMARY KEY AUTOINCREMENT,
started_at REAL NOT NULL,
messages_count INTEGER NOT NULL,
attachments_count INTEGER NOT NULL,
rich_links_count INTEGER NOT NULL,
ended_at REAL,
error_code INTEGER,
error_domain TEXT);
CREATE TABLE indexing_analytics_dropped_index_events (id INTEGER PRIMARY KEY AUTOINCREMENT,
timestamp REAL NOT NULL);
CREATE TABLE indexing_analytics_message_donations_enqueued (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
source INTEGER NOT NULL,
started_at REAL NOT NULL,
ended_at REAL,
error INTEGER);
CREATE TABLE indexing_analytics_message_donations_identified (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
reason INTEGER NOT NULL,
started_at REAL NOT NULL,
recorded INTEGER NOT NULL,
ended_at REAL);
CREATE TABLE indexing_analytics_rich_link_donations_enqueued (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
source INTEGER NOT NULL,
started_at REAL NOT NULL,
ended_at REAL,
error INTEGER);
CREATE TABLE indexing_analytics_rich_link_donations_identified (id INTEGER PRIMARY KEY AUTOINCREMENT,
item INTEGER NOT NULL,
reason INTEGER NOT NULL,
started_at REAL NOT NULL,
recorded INTEGER NOT NULL,
ended_at REAL);
CREATE TABLE labels (message_id INTEGER REFERENCES messages(ROWID) ON DELETE CASCADE, mailbox_id INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE, PRIMARY KEY(message_id, mailbox_id)) WITHOUT ROWID;
CREATE TABLE last_spotlight_check_date (message_id INTEGER NOT NULL UNIQUE ON CONFLICT REPLACE REFERENCES messages(ROWID) ON DELETE CASCADE, date INTEGER, PRIMARY KEY(message_id)) WITHOUT ROWID;
CREATE TABLE local_message_actions (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
source_mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
destination_mailbox INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
action_type INTEGER,
user_initiated INTEGER);
CREATE TABLE mailbox_actions (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
account_identifier TEXT,
action_type INTEGER,
mailbox_name TEXT,
mailbox INTEGER,
new_mailbox_name TEXT);
CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
url TEXT COLLATE BINARY NOT NULL,
total_count INTEGER NOT NULL DEFAULT 0,
unread_count INTEGER NOT NULL DEFAULT 0,
deleted_count INTEGER NOT NULL DEFAULT 0,
unseen_count INTEGER NOT NULL DEFAULT 0,
unread_count_adjusted_for_duplicates INTEGER NOT NULL DEFAULT 0,
change_identifier TEXT COLLATE BINARY,
source INTEGER,
alleged_change_identifier TEXT COLLATE BINARY,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE message_global_data (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER,
follow_up_start_date INTEGER,
follow_up_end_date INTEGER,
follow_up_jsonstringformodelevaluationforsuggestions TEXT COLLATE BINARY,
download_state INTEGER NOT NULL DEFAULT 0,
read_later_date INTEGER,
send_later_date INTEGER,
validation_state INTEGER NOT NULL DEFAULT 0,
model_category INTEGER,
model_subcategory INTEGER,
category_model_version INTEGER,
category_is_temporary INTEGER,
model_analytics TEXT COLLATE BINARY,
model_high_impact INTEGER NOT NULL DEFAULT 0,
generated_summary INTEGER,
urgent INTEGER,
message_id_header TEXT COLLATE BINARY,
UNIQUE(message_id) ON CONFLICT ABORT);
CREATE TABLE message_metadata (message_id INTEGER PRIMARY KEY,
timestamp INTEGER NOT NULL,
json_values TEXT COLLATE BINARY NOT NULL);
CREATE TABLE message_references (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL REFERENCES messages(ROWID) ON DELETE CASCADE,
reference INTEGER NOT NULL DEFAULT 0,
is_originator INTEGER NOT NULL DEFAULT 0);
CREATE TABLE message_rich_links (global_message_id INTEGER NOT NULL REFERENCES message_global_data(ROWID) ON DELETE CASCADE,
rich_link INTEGER NOT NULL REFERENCES rich_links(ROWID) ON DELETE CASCADE,
PRIMARY KEY(global_message_id, rich_link)) WITHOUT ROWID;
CREATE TABLE messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message_id INTEGER NOT NULL DEFAULT 0,
global_message_id INTEGER NOT NULL,
remote_id INTEGER,
document_id TEXT COLLATE BINARY,
sender INTEGER,
subject_prefix TEXT COLLATE BINARY,
subject INTEGER NOT NULL,
summary INTEGER,
date_sent INTEGER,
date_received INTEGER,
mailbox INTEGER NOT NULL,
remote_mailbox INTEGER,
flags INTEGER NOT NULL DEFAULT 0,
read INTEGER NOT NULL DEFAULT 0,
flagged INTEGER NOT NULL DEFAULT 0,
deleted INTEGER NOT NULL DEFAULT 0,
size INTEGER NOT NULL DEFAULT 0,
conversation_id INTEGER NOT NULL DEFAULT 0,
date_last_viewed INTEGER,
list_id_hash INTEGER,
unsubscribe_type INTEGER,
searchable_message INTEGER,
brand_indicator INTEGER,
display_date INTEGER,
flag_color INTEGER,
is_urgent INTEGER NOT NULL DEFAULT 0,
color TEXT COLLATE BINARY,
type INTEGER,
fuzzy_ancestor INTEGER,
automated_conversation INTEGER DEFAULT 0,
root_status INTEGER DEFAULT -1);
CREATE TABLE properties (ROWID INTEGER PRIMARY KEY, key, value, UNIQUE (key));
CREATE TABLE protected_message_data (ROWID INTEGER PRIMARY KEY,
data TEXT COLLATE BINARY);
CREATE TABLE recipients (ROWID INTEGER PRIMARY KEY,
message INTEGER NOT NULL,
address INTEGER NOT NULL,
type INTEGER,
position INTEGER,
UNIQUE(message, type, position) ON CONFLICT ABORT);
CREATE TABLE remote_content_links (ROWID INTEGER PRIMARY KEY,
url TEXT COLLATE BINARY NOT NULL,
requests INTEGER NOT NULL DEFAULT 0,
last_seen_date INTEGER NOT NULL,
last_request_date INTEGER NOT NULL DEFAULT 0,
UNIQUE(url) ON CONFLICT ABORT);
CREATE TABLE rich_links (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
title TEXT COLLATE BINARY,
url TEXT COLLATE BINARY NOT NULL,
hash TEXT COLLATE BINARY NOT NULL,
UNIQUE(hash) ON CONFLICT ABORT);
CREATE TABLE searchable_attachments (attachment_id INTEGER PRIMARY KEY,
attachment INTEGER REFERENCES attachments(ROWID) ON DELETE SET NULL,
message_id INTEGER,
transaction_id INTEGER NOT NULL);
CREATE TABLE searchable_data_detection_results (ROWID INTEGER PRIMARY KEY,
data_detection_result INTEGER,
message INTEGER,
transaction_id INTEGER NOT NULL);
CREATE TABLE searchable_message_tombstones (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
type INTEGER NOT NULL,
identifier TEXT COLLATE BINARY NOT NULL,
transaction_id INTEGER,
UNIQUE(type, identifier) ON CONFLICT ABORT);
CREATE TABLE searchable_messages (message_id INTEGER PRIMARY KEY,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
transaction_id INTEGER NOT NULL,
message_body_indexed INTEGER NOT NULL,
reindex_type INTEGER NOT NULL);
CREATE TABLE searchable_rich_links (rich_link_id INTEGER PRIMARY KEY,
rich_link INTEGER REFERENCES rich_links(ROWID) ON DELETE SET NULL,
message_id INTEGER,
transaction_id INTEGER NOT NULL);
CREATE TABLE sender_addresses (address INTEGER PRIMARY KEY,
sender INTEGER NOT NULL REFERENCES senders(ROWID) ON DELETE CASCADE);
CREATE TABLE senders (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
contact_identifier TEXT COLLATE BINARY,
bucket INTEGER NOT NULL DEFAULT 0,
user_initiated INTEGER NOT NULL DEFAULT 1,
UNIQUE(contact_identifier) ON CONFLICT ABORT);
CREATE TABLE server_labels (server_message INTEGER REFERENCES server_messages(ROWID) ON DELETE CASCADE,
label INTEGER REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
PRIMARY KEY(server_message, label)) WITHOUT ROWID;
CREATE TABLE server_messages (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
message INTEGER REFERENCES messages(ROWID) ON DELETE SET NULL,
mailbox INTEGER NOT NULL REFERENCES mailboxes(ROWID) ON DELETE CASCADE,
sequence_identifier INTEGER,
read INTEGER NOT NULL,
deleted INTEGER NOT NULL,
replied INTEGER NOT NULL,
flagged INTEGER NOT NULL,
draft INTEGER NOT NULL,
forwarded INTEGER NOT NULL,
redirected INTEGER NOT NULL,
junk_level_set_by_user INTEGER NOT NULL,
junk_level INTEGER NOT NULL,
flag_color INTEGER NOT NULL,
remote_id INTEGER NOT NULL,
UNIQUE(mailbox, remote_id) ON CONFLICT ABORT);
CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
subject TEXT COLLATE RTRIM NOT NULL,
UNIQUE(subject) ON CONFLICT ABORT);
CREATE TABLE summaries (ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
summary TEXT COLLATE RTRIM NOT NULL,
UNIQUE(summary) ON CONFLICT ABORT);
CREATE INDEX action_flags_action_index ON action_flags(action);
CREATE INDEX action_labels_action_index ON action_labels(action);
CREATE INDEX action_labels_label_index ON action_labels(label);
CREATE INDEX action_messages_action_index ON action_messages(action);
CREATE INDEX action_messages_destination_message_index ON action_messages(destination_message);
CREATE INDEX action_messages_message_index ON action_messages(message);
CREATE INDEX additional_remote_content_links_requests_last_request_date_index ON additional_remote_content_links(requests, last_request_date);
CREATE INDEX additional_remote_content_links_requests_last_seen_date_index ON additional_remote_content_links(requests, last_seen_date);
CREATE INDEX attachments_message_attachment_id_index ON attachments(message, attachment_id);
CREATE INDEX attachments_message_name_index ON attachments(message, name);
CREATE INDEX brand_indicator_evidence_unverified_messages_index ON brand_indicator_evidence(unverified_messages) WHERE unverified_messages IS NOT NULL;
CREATE INDEX conversation_id_message_id_message_id_conversation_id_index ON conversation_id_message_id(message_id, conversation_id);
CREATE INDEX conversations_flags_index ON conversations(flags);
CREATE INDEX duplicates_unread_count_mailbox_id_index ON duplicates_unread_count(mailbox_id);
CREATE INDEX events_message_id_index ON events(message_id);
CREATE INDEX ews_folders_mailbox_id_index ON ews_folders(mailbox_id);
CREATE INDEX indexing_analytics_attachment_donations_identified_item_started_at_index
          ON indexing_analytics_attachment_donations_identified(item, started_at);
CREATE INDEX indexing_analytics_message_donations_identified_item_started_at_index
          ON indexing_analytics_message_donations_identified(item, started_at);
CREATE INDEX indexing_analytics_rich_link_donations_identified_item_started_at_index
          ON indexing_analytics_rich_link_donations_identified(item, started_at);
CREATE INDEX labels_mailbox_id_index on labels(mailbox_id);
CREATE INDEX last_spotlight_check_date_message_id_date_index ON last_spotlight_check_date(message_id, date);
CREATE INDEX local_message_actions_mailbox_rowid_index ON local_message_actions(mailbox, ROWID);
CREATE INDEX mailboxes_source_index ON mailboxes(source);
CREATE INDEX message_global_data_category_model_version_model_category_index ON message_global_data(category_model_version, model_category);
CREATE INDEX message_global_data_follow_up_end_date_index ON message_global_data(follow_up_end_date);
CREATE INDEX message_global_data_follow_up_jsonstringformodelevaluationforsuggestions_index ON message_global_data(follow_up_jsonstringformodelevaluationforsuggestions);
CREATE INDEX message_global_data_follow_up_start_date_index ON message_global_data(follow_up_start_date);
CREATE INDEX message_global_data_model_category_index ON message_global_data(model_category);
CREATE INDEX message_global_data_read_later_date_index ON message_global_data(read_later_date);
CREATE INDEX message_global_data_send_later_date_index ON message_global_data(send_later_date);
CREATE INDEX message_global_data_validation_state_equals_zero_index ON message_global_data(validation_state) WHERE validation_state = 0;
CREATE INDEX message_metadata_timestamp_index ON message_metadata(timestamp);
CREATE INDEX message_references_message_reference_index ON message_references(message, reference);
CREATE INDEX message_references_reference_message_index ON message_references(reference, message);
CREATE INDEX messages_brand_indicator_index ON messages(brand_indicator);
CREATE INDEX messages_conversation_id_index ON messages(conversation_id);
CREATE INDEX messages_conversation_id_mailbox_deleted_index ON messages(conversation_id, mailbox, deleted);
CREATE INDEX messages_conversation_id_mailbox_flagged_deleted_index ON messages(conversation_id, mailbox, flagged, deleted);
CREATE INDEX messages_conversation_id_mailbox_flags_deleted_index ON messages(conversation_id, mailbox, flags, deleted);
CREATE INDEX messages_conversation_id_mailbox_read_date_received_deleted_index ON messages(conversation_id, mailbox, read, date_received, deleted);
CREATE INDEX messages_conversation_id_mailbox_sender_date_received_deleted_index ON messages(conversation_id, mailbox, sender, date_received, deleted);
CREATE INDEX messages_date_last_viewed_index ON messages(date_last_viewed);
CREATE INDEX messages_date_received_index ON messages(date_received);
CREATE INDEX messages_deleted_date_received_index ON messages(deleted, date_received);
CREATE INDEX messages_deleted_index ON messages(deleted);
CREATE INDEX messages_deleted_mailbox_index ON messages(deleted, mailbox);
CREATE INDEX messages_document_id_index ON messages(document_id);
CREATE INDEX messages_flag_color_index ON messages(flag_color);
CREATE INDEX messages_flagged_index ON messages(flagged);
CREATE INDEX messages_fuzzy_ancestor_index ON messages(fuzzy_ancestor);
CREATE INDEX messages_global_message_id_mailbox_index ON messages(global_message_id, mailbox);
CREATE INDEX messages_is_urgent_deleted_conversation_id_is_urgent_1_deleted_0_index ON messages(is_urgent, deleted, conversation_id) WHERE (is_urgent = 1 AND deleted = 0);
CREATE INDEX messages_list_id_hash_index ON messages(list_id_hash);
CREATE INDEX messages_mailbox_conversation_id_date_received_deleted_index ON messages(mailbox, conversation_id, date_received, deleted);
CREATE INDEX messages_mailbox_date_received_index ON messages(mailbox, date_received);
CREATE INDEX messages_mailbox_display_date_index ON messages(mailbox, display_date);
CREATE INDEX messages_mailbox_is_urgent_display_date_index ON messages(mailbox, is_urgent, display_date);
CREATE INDEX messages_message_id_mailbox_index ON messages(message_id, mailbox);
CREATE INDEX messages_read_deleted_global_message_id_mailbox_read0_deleted0_index ON messages(read, deleted, global_message_id, mailbox) WHERE (read = 0 AND deleted = 0);
CREATE INDEX messages_remote_mailbox_remote_id_index ON messages(remote_mailbox, remote_id);
CREATE INDEX messages_root_status_index ON messages(root_status);
CREATE INDEX messages_searchable_message_deleted_date_received_index ON messages(searchable_message, deleted, date_received);
CREATE INDEX messages_sender_index ON messages(sender);
CREATE INDEX messages_sender_subject_automated_conversation_index ON messages(sender, subject, automated_conversation);
CREATE INDEX messages_subject_fuzzy_ancestor_index ON messages(subject, fuzzy_ancestor);
CREATE INDEX messages_subject_index ON messages(subject);
CREATE INDEX messages_summary_index ON messages(summary);
CREATE INDEX messages_type_index ON messages(type);
CREATE INDEX recipients_address_index ON recipients(address);
CREATE INDEX recipients_message_position_type_address_index ON recipients(message, position, type, address);
CREATE INDEX remote_content_links_requests_last_request_date_index ON remote_content_links(requests, last_request_date);
CREATE INDEX remote_content_links_requests_last_seen_date_index ON remote_content_links(requests, last_seen_date);
CREATE INDEX searchable_attachments_attachment_index ON searchable_attachments(attachment);
CREATE INDEX searchable_attachments_message_id_index ON searchable_attachments(message_id);
CREATE INDEX searchable_data_detection_results_data_detection_result_index ON searchable_data_detection_results(data_detection_result);
CREATE INDEX searchable_data_detection_results_message_index ON searchable_data_detection_results(message);
CREATE INDEX searchable_message_tombstones_transaction_id_type_identifier_index ON searchable_message_tombstones(transaction_id, type, identifier);
CREATE INDEX searchable_messages_message_reindex_type_transaction_id_index ON searchable_messages(message, reindex_type, transaction_id);
CREATE INDEX searchable_messages_reindex_type_message_index ON searchable_messages(reindex_type, message);
CREATE INDEX searchable_messages_transaction_id_message_index ON searchable_messages(transaction_id, message);
CREATE INDEX searchable_rich_links_message_id_index ON searchable_rich_links(message_id);
CREATE INDEX searchable_rich_links_rich_link_index ON searchable_rich_links(rich_link);
CREATE INDEX sender_addresses_sender_index ON sender_addresses(sender);
CREATE INDEX senders_bucket_index ON senders(bucket);
CREATE INDEX server_messages_message_index ON server_messages(message);
CREATE TRIGGER after_delete_label AFTER DELETE ON labels
BEGIN
UPDATE mailboxes SET total_count = MAX(0, total_count - 1) WHERE mailboxes.ROWID = OLD.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = OLD.message_id LIMIT 1);
UPDATE mailboxes SET unseen_count = MAX(0, unseen_count - 1) WHERE mailboxes.ROWID = OLD.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = OLD.message_id AND flags&1 = 0 LIMIT 1);
UPDATE mailboxes SET deleted_count = MAX(0, deleted_count - 1) WHERE mailboxes.ROWID = OLD.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = OLD.message_id AND flags&2 != 0 LIMIT 1);
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MAX(MIN(1, unread_count), unread_count_adjusted_for_duplicates - 1) WHERE mailboxes.ROWID = OLD.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = OLD.message_id AND flags&1 = 0 AND flags&2 = 0 LIMIT 1) AND (SELECT count() FROM labels WHERE message_id IN (SELECT ROWID FROM messages WHERE message_id IN (SELECT NULLIF(message_id, 0) FROM messages WHERE ROWID = OLD.message_id) AND ROWID != OLD.message_id) AND mailbox_id = OLD.mailbox_id) = 0;
UPDATE mailboxes SET unread_count = MAX(0, unread_count - 1), unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates, unread_count - 1) WHERE mailboxes.ROWID = OLD.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = OLD.message_id AND flags&1 = 0 AND flags&2 = 0 LIMIT 1);
END;
CREATE TRIGGER after_delete_message AFTER DELETE ON messages
BEGIN
DELETE FROM subjects WHERE ROWID = OLD.subject AND (SELECT COUNT() FROM messages WHERE subject = OLD.subject LIMIT 1) = 0;
DELETE FROM message_global_data WHERE ROWID = OLD.global_message_id AND (SELECT COUNT() FROM messages WHERE global_message_id = OLD.global_message_id LIMIT 1) = 0;
DELETE FROM addresses WHERE ROWID = OLD.sender AND ((SELECT COUNT() FROM messages WHERE sender = OLD.sender LIMIT 1) = 0) AND ((SELECT COUNT() FROM recipients WHERE address = OLD.sender LIMIT 1) = 0);
DELETE FROM summaries WHERE ROWID = OLD.summary AND (SELECT COUNT() FROM messages WHERE summary = OLD.summary LIMIT 1) = 0;
DELETE FROM brand_indicators WHERE ROWID = OLD.brand_indicator AND (SELECT COUNT() FROM messages WHERE brand_indicator = OLD.brand_indicator LIMIT 1) = 0;

UPDATE messages SET fuzzy_ancestor = -1 WHERE messages.fuzzy_ancestor = OLD.ROWID;
END;
CREATE TRIGGER after_insert_label AFTER INSERT ON labels
BEGIN
UPDATE mailboxes SET total_count = total_count + 1 WHERE mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = NEW.message_id LIMIT 1);
UPDATE mailboxes SET unseen_count = unseen_count + 1 WHERE mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = NEW.message_id AND flags&1 = 0 LIMIT 1);
UPDATE mailboxes SET deleted_count = deleted_count + 1 WHERE mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = NEW.message_id AND flags&2 != 0 LIMIT 1);
UPDATE mailboxes SET unread_count = unread_count + 1 WHERE mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = NEW.message_id AND flags&1 = 0 AND flags&2 = 0 LIMIT 1);
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates + 1, unread_count) WHERE mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source IN (SELECT mailbox FROM messages WHERE ROWID = NEW.message_id AND flags&1 = 0 AND flags&2 = 0 LIMIT 1) AND (SELECT count() FROM labels WHERE message_id IN (SELECT ROWID FROM messages WHERE message_id IN (SELECT NULLIF(message_id, 0) FROM messages WHERE ROWID = NEW.message_id) AND ROWID != NEW.message_id) AND mailbox_id = NEW.mailbox_id) = 0;
END;
CREATE TRIGGER after_insert_message AFTER INSERT ON messages
BEGIN
UPDATE mailboxes SET total_count = total_count + 1 WHERE (mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox);
UPDATE mailboxes SET unseen_count = unseen_count + 1 WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND NEW.flags&1 = 0;
UPDATE mailboxes SET deleted_count = deleted_count + 1 WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND NEW.flags&2 != 0;
END;
CREATE TRIGGER after_insert_message_unread AFTER INSERT ON messages WHEN (NEW.flags&1 = 0 AND NEW.flags&2 = 0)
BEGIN
UPDATE mailboxes SET unread_count = unread_count + 1 WHERE (mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox);

INSERT OR IGNORE INTO duplicates_unread_count (message_id, mailbox_id) VALUES (NULLIF(NEW.message_id, 0), NEW.mailbox);
UPDATE duplicates_unread_count SET unread_count = unread_count + 1 WHERE NEW.message_id != 0 AND duplicates_unread_count.message_id = NEW.message_id AND duplicates_unread_count.mailbox_id = NEW.mailbox;
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates + 1, unread_count) WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND NEW.message_id = 0;
END;
CREATE TRIGGER after_update_duplicates_unread_count_becoming_read AFTER UPDATE OF unread_count ON duplicates_unread_count WHEN OLD.unread_count = 1 AND NEW.unread_count = 0
BEGIN
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MAX(MIN(1, unread_count), unread_count_adjusted_for_duplicates - 1) WHERE (mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id IN (SELECT ROWID FROM messages WHERE message_id = NEW.message_id AND mailbox = NEW.mailbox_id)) AND mailboxes.source = NEW.mailbox_id);

DELETE FROM duplicates_unread_count WHERE rowid = NEW.rowid;
END;
CREATE TRIGGER after_update_duplicates_unread_count_becoming_unread AFTER UPDATE OF unread_count ON duplicates_unread_count WHEN OLD.unread_count = 0 AND NEW.unread_count = 1
BEGIN
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates + 1, unread_count) WHERE (mailboxes.ROWID = NEW.mailbox_id AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id IN (SELECT ROWID FROM messages WHERE message_id = NEW.message_id AND mailbox = NEW.mailbox_id)) AND mailboxes.source = NEW.mailbox_id);
END;
CREATE TRIGGER after_update_message AFTER UPDATE OF flags ON messages
BEGIN
UPDATE mailboxes SET unseen_count = MAX(0, unseen_count - 1) WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND OLD.flags&1 = 0 AND NEW.flags&1 != 0;
UPDATE mailboxes SET deleted_count = MAX(0, deleted_count - 1) WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND OLD.flags&2 != 0 AND NEW.flags&2 = 0;

UPDATE mailboxes SET unseen_count = unseen_count + 1 WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND OLD.flags&1 != 0 AND NEW.flags&1 = 0;
UPDATE mailboxes SET deleted_count = deleted_count + 1 WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND OLD.flags&2 = 0 AND NEW.flags&2 != 0;
END;
CREATE TRIGGER after_update_message_becoming_read AFTER UPDATE OF flags ON messages WHEN (OLD.flags&1 = 0 AND OLD.flags&2 = 0) AND (NEW.flags&1 != 0 OR NEW.flags&2 != 0)
BEGIN
UPDATE duplicates_unread_count SET unread_count = unread_count - 1 WHERE OLD.message_id != 0 AND duplicates_unread_count.message_id = OLD.message_id AND duplicates_unread_count.mailbox_id = OLD.mailbox;
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MAX(MIN(1, unread_count), unread_count_adjusted_for_duplicates - 1) WHERE ((mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND mailboxes.source = OLD.mailbox)) AND OLD.message_id = 0;

UPDATE mailboxes SET unread_count = MAX(0, unread_count - 1), unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates, unread_count - 1) WHERE (mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox);
END;
CREATE TRIGGER after_update_message_becoming_unread AFTER UPDATE OF flags ON messages WHEN (OLD.flags&1 != 0 OR OLD.flags&2 != 0) AND (NEW.flags&1 = 0 AND NEW.flags&2 = 0)
BEGIN
UPDATE mailboxes SET unread_count = unread_count + 1 WHERE (mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox);

INSERT OR IGNORE INTO duplicates_unread_count (message_id, mailbox_id) VALUES (NULLIF(NEW.message_id, 0), NEW.mailbox);
UPDATE duplicates_unread_count SET unread_count = unread_count + 1 WHERE NEW.message_id != 0 AND duplicates_unread_count.message_id = NEW.message_id AND duplicates_unread_count.mailbox_id = NEW.mailbox;
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates + 1, unread_count) WHERE ((mailboxes.ROWID = NEW.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = NEW.ROWID) AND mailboxes.source = NEW.mailbox)) AND NEW.message_id = 0;
END;
CREATE TRIGGER before_delete_message BEFORE DELETE ON messages
BEGIN
UPDATE duplicates_unread_count SET unread_count = unread_count - 1 WHERE (OLD.message_id != 0 AND duplicates_unread_count.message_id = OLD.message_id AND duplicates_unread_count.mailbox_id = OLD.mailbox) AND (OLD.flags&1 = 0 AND OLD.flags&2 = 0);
UPDATE mailboxes SET unread_count_adjusted_for_duplicates = MAX(MIN(1, unread_count), unread_count_adjusted_for_duplicates - 1) WHERE ((mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL AND OLD.message_id = 0) OR (mailboxes.source NOTNULL AND mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND ((mailboxes.source = OLD.mailbox AND OLD.message_id = 0) OR ((SELECT count() FROM labels WHERE message_id IN (SELECT ROWID FROM messages WHERE message_id = OLD.message_id) AND mailbox_id = mailboxes.ROWID) = 0 AND OLD.message_id != 0)))) AND (OLD.flags&1 = 0 AND OLD.flags&2 = 0);

UPDATE mailboxes SET unread_count = MAX(0, unread_count - 1), unread_count_adjusted_for_duplicates = MIN(unread_count_adjusted_for_duplicates, unread_count - 1) WHERE ((mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND mailboxes.source = OLD.mailbox)) AND (OLD.flags&1 = 0 AND OLD.flags&2 = 0);

UPDATE mailboxes SET total_count = MAX(0, total_count - 1) WHERE (mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND mailboxes.source = OLD.mailbox);
UPDATE mailboxes SET unseen_count = MAX(0, unseen_count - 1) WHERE (mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL AND OLD.flags&1 = 0) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND mailboxes.source = OLD.mailbox AND OLD.flags&1 = 0);
UPDATE mailboxes SET deleted_count = MAX(0, deleted_count - 1) WHERE (mailboxes.ROWID = OLD.mailbox AND mailboxes.source ISNULL AND OLD.flags&2 != 0) OR (mailboxes.ROWID IN (SELECT mailbox_id FROM labels WHERE message_id = OLD.ROWID) AND mailboxes.source = OLD.mailbox AND OLD.flags&2 != 0);
END;
