-- Captured from a real store by scripts/probe-calendar.mjs --write.
-- macOS 26.6, fingerprint 2bf4e34ff75f, 168 objects.
-- Schema only. No data.

CREATE TABLE Alarm (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, trigger_date REAL, trigger_interval INTEGER, type INTEGER, calendaritem_owner_id INTEGER, calendar_owner_id INTEGER, external_mod_tag TEXT, external_id_tag TEXT, external_rep BLOB, UUID TEXT, proximity INTEGER, disabled INTEGER, location_id INTEGER, acknowledgedDate REAL, default_alarm INTEGER, orig_alarm_id INTEGER, email_address TEXT, bookmark BLOB, has_long_interval INTEGER);
CREATE TABLE AlarmCache (event_id INTEGER, alarm_id INTEGER, occurrence_date REAL, fire_date REAL, store_id INTEGER, all_day INTEGER, travel_time REAL, is_default INTEGER, PRIMARY KEY (event_id, alarm_id, occurrence_date));
CREATE TABLE AlarmChanges (record INTEGER, type INTEGER, sequence_number INTEGER, calendaritem_owner_id INTEGER, calendar_owner_id INTEGER, store_id INTEGER, calendar_id INTEGER, UUID TEXT);
CREATE TABLE Attachment (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, external_rep BLOB, file_id INTEGER);
CREATE TABLE AttachmentChanges (record INTEGER, type INTEGER, sequence_number INTEGER, owner_id INTEGER, external_id TEXT, UUID TEXT, store_id INTEGER, calendar_id INTEGER);
CREATE TABLE AttachmentFile (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, external_id TEXT, external_mod_tag TEXT, url TEXT, UUID TEXT, format TEXT, flags INTEGER, filename TEXT, local_path TEXT, file_size INTEGER, store_id INTEGER, download_start REAL, download_tries INTEGER);
CREATE TABLE AuxDatabase (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT, persona_id TEXT UNIQUE);
CREATE TABLE AuxDatabaseAccount (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT UNIQUE, database_id INTEGER);
CREATE TABLE AuxDatabaseChanges (record INTEGER, type INTEGER, sequence_number INTEGER, persona_id TEXT);
CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, title TEXT, flags INTEGER, color TEXT, symbolic_color_name TEXT, color_is_display INTEGER, type TEXT, supported_entity_types INTEGER, external_id TEXT, external_mod_tag TEXT, external_id_tag TEXT, external_rep BLOB, display_order INTEGER, UUID TEXT, shared_owner_name TEXT, shared_owner_address TEXT, cached_external_info BLOB, sharing_status INTEGER, sharing_invitation_response INTEGER, published_URL TEXT, is_published INTEGER, invitation_status INTEGER, sync_token TEXT, self_identity_id INTEGER, self_identity_email TEXT, self_identity_phone_number TEXT, owner_identity_id INTEGER, owner_identity_email TEXT, owner_identity_phone_number TEXT, notes TEXT, bulk_requests BLOB, subcal_account_id TEXT, push_key TEXT, digest BLOB, refresh_date REAL, subscription_id TEXT, last_sync_start REAL, last_sync_end REAL, subcal_url TEXT, refresh_interval INTEGER, pubcal_account_id TEXT, error_id INTEGER, max_attendees INTEGER, last_sync_title TEXT, locale TEXT, image_id INTEGER);
CREATE TABLE CalendarChanges (record INTEGER, type INTEGER, sequence_number INTEGER, store_id INTEGER, title INTEGER, flags INTEGER, color INTEGER, external_id TEXT, external_id_tag TEXT, display_order INTEGER, UUID TEXT, old_flags INTEGER);
CREATE TABLE CalendarItem (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, summary TEXT, location_id INTEGER, client_location_id INTEGER, description TEXT, start_date REAL, start_tz TEXT, end_date REAL, end_tz TEXT, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, orig_date REAL, organizer_id INTEGER, self_attendee_id INTEGER, status INTEGER, invitation_status INTEGER, availability INTEGER, privacy_level INTEGER, url TEXT, last_modified REAL, sequence_num INTEGER, birthday_id INTEGER, modified_properties INTEGER, external_tracking_status INTEGER, external_id TEXT, external_mod_tag TEXT, unique_identifier TEXT, external_schedule_id TEXT, external_rep BLOB, response_comment TEXT, last_synced_response_comment TEXT, hidden INTEGER, has_recurrences INTEGER, has_attachment INTEGER, has_attendees INTEGER, UUID TEXT, entity_type INTEGER, priority INTEGER, due_date REAL, due_tz TEXT, due_all_day INTEGER, completion_date REAL, creation_date REAL, action TEXT, app_link BLOB, display_order INTEGER, created_by_id INTEGER, modified_by_id INTEGER, shared_item_created_date REAL, shared_item_created_tz TEXT, shared_item_modified_date REAL, shared_item_modified_tz TEXT, invitation_changed_properties INTEGER, default_alarm_removed INTEGER, phantom_master INTEGER, participation_status_modified_date REAL, calendar_scale TEXT, travel_time INTEGER, travel_advisory_behavior INTEGER, start_location_id INTEGER, end_location_id INTEGER, suggested_event_info_id INTEGER, first_alert_date REAL, proposed_start_date REAL, can_forward INTEGER, location_prediction_state INTEGER, fired_ttl INTEGER, disallow_propose_new_time INTEGER, structured_data BLOB, local_structured_data BLOB, junk_status INTEGER, conference_url TEXT, contact_identifier TEXT, recurrence_set TEXT, flags INTEGER, contact_name TEXT, error_id INTEGER, image_id INTEGER, color_id INTEGER, conference_url_detected TEXT, creator_identity TEXT, creator_team_identity TEXT, special_day TEXT);
CREATE TABLE CalendarItemChanges (record INTEGER, type INTEGER, sequence_number INTEGER, summary INTEGER, location_id INTEGER, description INTEGER, start_date INTEGER, start_tz INTEGER, end_date INTEGER, end_tz INTEGER, all_day INTEGER, calendar_id INTEGER, orig_item_id INTEGER, status INTEGER, availability INTEGER, privacy_level INTEGER, external_id TEXT, unique_identifier TEXT, UUID TEXT, entity_type INTEGER, travel_time INTEGER, start_location_id INTEGER, proposed_start_date INTEGER, recurrence_set TEXT, store_id INTEGER, has_dirty_instance_attributes INTEGER, old_calendar_id INTEGER, old_external_id TEXT, has_recurrence_set_changed INTEGER, suppress_notification_for_changes INTEGER);
CREATE TABLE Category (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, entity_type INTEGER, hidden INTEGER);
CREATE TABLE CategoryLink (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, category_id INTEGER, group_id INTEGER);
CREATE TABLE ClientCursor (     ROWID INTEGER PRIMARY KEY AUTOINCREMENT,     client_identifier TEXT,     store_id INTEGER,     latest_consumed_sequence_number INTEGER,     latest_consumed_timestamp REAL,     UNIQUE(client_identifier) );
CREATE TABLE ClientCursorConsumed (    client_identifier TEXT,     consumed_entity_class INTEGER,     consumed_entity_id INTEGER,     consumed_change_id INTEGER,     sequence_number INTEGER );
CREATE TABLE ClientSequence (client_identifier TEXT, sequence_number INTEGER, timestamp REAL );
CREATE TABLE Color (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, data BLOB, provider_id TEXT, uuid TEXT, external_id TEXT);
CREATE TABLE Conference (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, owner_id INTEGER, url TEXT, feature TEXT, info TEXT, language TEXT, region TEXT);
CREATE TABLE Contact (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, contact_id TEXT);
CREATE TABLE ContactChanges (record INTEGER, type INTEGER, sequence_number INTEGER, owner_id INTEGER, contact_id TEXT, store_id INTEGER, calendar_id INTEGER);
CREATE TABLE Error (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_owner_id INTEGER, calendar_owner_id INTEGER, calendaritem_owner_id INTEGER, error_type INTEGER, error_code INTEGER, user_info BLOB);
CREATE TABLE EventAction (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, external_id TEXT, external_mod_tag TEXT, external_folder_id TEXT, external_schedule_id TEXT, external_rep BLOB);
CREATE TABLE EventActionChanges (record INTEGER, type INTEGER, sequence_number INTEGER, event_id INTEGER, external_id TEXT, external_folder_id TEXT, external_schedule_id TEXT, store_id INTEGER, calendar_id INTEGER);
CREATE TABLE ExceptionDate (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, date REAL, sync_order INTEGER);
CREATE TABLE ExceptionDateChanges (record INTEGER, type INTEGER, sequence_number INTEGER, owner_id INTEGER, date REAL, store_id INTEGER, calendar_id INTEGER);
CREATE TABLE Identity (display_name TEXT, address TEXT, first_name TEXT, last_name TEXT, UNIQUE (display_name, address, first_name, last_name));
CREATE TABLE Image (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, store_id INTEGER, type INTEGER, name TEXT, color BLOB, identifier TEXT);
CREATE TABLE Location (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, address TEXT, latitude INTEGER, longitude INTEGER, reference_frame INTEGER, address_book_id TEXT, mapkit_handle BLOB, radius INTEGER, routing TEXT, derived_from TEXT, item_owner_id INTEGER, alarm_owner_id INTEGER, start_loc_owner_id INTEGER, end_loc_owner_id INTEGER, client_loc_owner_id INTEGER);
CREATE TABLE Notification (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, entity_type INTEGER, calendar_id INTEGER, invite_reply_calendar_id INTEGER, external_id TEXT, external_mod_tag TEXT, UUID TEXT, summary TEXT, creation_date REAL, last_modified REAL, status INTEGER, host_url TEXT, in_reply_to TEXT, identity_id INTEGER, alerted INTEGER);
CREATE TABLE NotificationChanges (record INTEGER, type INTEGER, sequence_number INTEGER, entity_type INTEGER, calendar_id INTEGER, invite_reply_calendar_id INTEGER, external_id TEXT, UUID TEXT, store_id INTEGER);
CREATE TABLE OccurrenceCache (day REAL, event_id INTEGER, calendar_id INTEGER, store_id INTEGER, occurrence_date REAL, occurrence_start_date REAL, occurrence_end_date REAL, latest_possible_alarm REAL, earliest_possible_alarm REAL, next_reminder_date REAL);
CREATE TABLE OccurrenceCacheDays (calendar_id INTEGER, store_id INTEGER, day REAL, count INTEGER, PRIMARY KEY (calendar_id, day));
CREATE TABLE Participant (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, entity_type INTEGER, type INTEGER, status INTEGER, pending_status INTEGER, role INTEGER, identity_id INTEGER, owner_id INTEGER, external_rep BLOB, UUID TEXT, email TEXT, phone_number TEXT, is_self INTEGER, comment TEXT, schedule_agent INTEGER, flags INTEGER, last_modified REAL, proposed_start_date REAL, invited_by TEXT, proposed_start_date_status INTEGER, schedule_status INTEGER, schedule_force_send INTEGER, comment_last_modified REAL);
CREATE TABLE ParticipantChanges (record INTEGER, type INTEGER, sequence_number INTEGER, entity_type INTEGER, status INTEGER, role INTEGER, owner_id INTEGER, UUID TEXT, email TEXT, phone_number TEXT, comment TEXT, store_id INTEGER, calendar_id INTEGER);
CREATE TABLE Recurrence (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, frequency INTEGER, interval INTEGER, week_start INTEGER, count INTEGER, cached_end_date REAL, cached_end_date_tz TEXT, end_date REAL, specifier TEXT, by_month_months INTEGER, owner_id INTEGER, external_id TEXT, external_mod_tag TEXT, external_id_tag TEXT, external_rep BLOB, UUID TEXT);
CREATE TABLE RecurrenceChanges (record INTEGER, type INTEGER, sequence_number INTEGER, external_id TEXT, store_id INTEGER, event_id_tomb INTEGER, calendar_id INTEGER, end_date_tomb REAL, UUID TEXT);
CREATE TABLE ResourceChange (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, notification_id INTEGER, calendar_id INTEGER, calendar_item_id INTEGER, identity_id INTEGER, change_type INTEGER, timestamp REAL, changed_properties INTEGER, create_count INTEGER, update_count INTEGER, delete_count INTEGER, deleted_summary TEXT, deleted_start_date REAL, alerted INTEGER, public_status INTEGER);
CREATE TABLE ScheduledTaskCache (day REAL, date_for_sorting REAL, completed INTEGER, task_id INTEGER, count INTEGER, PRIMARY KEY (day, task_id));
CREATE TABLE Sharee (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, external_id TEXT, external_rep BLOB, UUID TEXT, identity_id INTEGER, status INTEGER, access_level INTEGER, mute_notifications INTEGER);
CREATE TABLE ShareeChanges (record INTEGER, type INTEGER, sequence_number INTEGER, owner_id INTEGER, UUID TEXT, status INTEGER, access_level INTEGER, mute_notifications INTEGER, display_name TEXT, address TEXT, store_id INTEGER, calendar_id INTEGER, first_name TEXT, last_name TEXT);
CREATE TABLE Store (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, notes TEXT, default_alarm_offset INTEGER, type INTEGER, constraint_path TEXT, disabled INTEGER, external_id TEXT, persistent_id TEXT, flags INTEGER, creator_bundle_id TEXT, creator_code_signing_identity TEXT, only_creator_can_modify INTEGER, external_mod_tag TEXT, preferred_event_private_value INTEGER, strictest_event_private_value INTEGER, last_sync_start REAL, last_sync_end REAL, delegated_account_owner_store_id TEXT, delegated_account_default_calendar_for_new_events_id INTEGER, shows_notifications INTEGER, flags2 INTEGER, display_order INTEGER, owner_name TEXT, default_all_day_alarm_offset INTEGER, error_id INTEGER, cached_external_info BLOB, app_group_id TEXT UNIQUE);
CREATE TABLE StoreChanges (record INTEGER, type INTEGER, sequence_number INTEGER, default_alarm_offset INTEGER, persistent_id TEXT, default_all_day_alarm_offset INTEGER);
CREATE TABLE SuggestedEventInfo (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER, opaque_key TEXT, unique_key TEXT, changed_fields INTEGER, changes_acknowledged INTEGER, timestamp REAL, extraction_group_identifier TEXT);
CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
CREATE INDEX AlarmCalendarItemOwnerId on Alarm(calendaritem_owner_id);
CREATE INDEX AlarmCalendarOwnerId on Alarm(calendar_owner_id);
CREATE INDEX AlarmChangesSequenceNumber on AlarmChanges(sequence_number);
CREATE INDEX AlarmOrigAlarmId on Alarm(orig_alarm_id);
CREATE INDEX AlarmTriggerDate on Alarm(trigger_date);
CREATE INDEX AlarmUUID on Alarm(UUID);
CREATE INDEX AlarmsWithLargeOffsets on Alarm(trigger_interval) WHERE has_long_interval = 1;
CREATE INDEX AttachmentChangesSequenceNumber on AttachmentChanges(sequence_number);
CREATE INDEX AttachmentEventId on Attachment(owner_id);
CREATE INDEX AttachmentFileExternalID on AttachmentFile(external_id);
CREATE INDEX AttachmentFileId on Attachment(file_id);
CREATE INDEX AttachmentFileStoreLocalPathDownloadTries on AttachmentFile(store_id, local_path, download_tries);
CREATE INDEX AttachmentFileStoreURL on AttachmentFile(store_id, url);
CREATE INDEX AttachmentFileUUID on AttachmentFile(UUID);
CREATE INDEX AuxDatabaseChangesSequenceNumber on AuxDatabaseChanges(sequence_number);
CREATE INDEX CalendarChangesSequenceNumber on CalendarChanges(sequence_number);
CREATE INDEX CalendarExternalId on Calendar(external_id);
CREATE INDEX CalendarImageId on Calendar(image_id) WHERE image_id > 0;
CREATE INDEX CalendarItemCalendarId on CalendarItem(calendar_id);
CREATE INDEX CalendarItemChangesSequenceNumber on CalendarItemChanges(sequence_number);
CREATE INDEX CalendarItemColorId on CalendarItem(color_id) WHERE color_id > 0;
CREATE INDEX CalendarItemCreatedById on CalendarItem(created_by_id) WHERE created_by_id > 0;
CREATE INDEX CalendarItemDueDate on CalendarItem(due_date);
CREATE INDEX CalendarItemImageId  on CalendarItem(image_id) WHERE image_id > 0;
CREATE INDEX CalendarItemModifiedById on CalendarItem(modified_by_id) WHERE modified_by_id > 0;
CREATE INDEX CalendarItemOriginalDate on CalendarItem(orig_date);
CREATE INDEX CalendarItemOriginalItemId on CalendarItem(orig_item_id);
CREATE INDEX CalendarItemRecurrenceSet on CalendarItem(recurrence_set, orig_item_id);
CREATE INDEX CalendarSelfIdentityId on Calendar(self_identity_id);
CREATE INDEX CalendarStoreId on Calendar(store_id);
CREATE INDEX CalendarUUID on Calendar(UUID);
CREATE INDEX CategoryLinkCategoryID on CategoryLink(category_id);
CREATE UNIQUE INDEX CategoryNameAndType on Category(name, entity_type);
CREATE INDEX ClientCursorClientIdentifier ON ClientCursor(client_identifier);
CREATE INDEX ClientCursorConsumedClientIdentifier ON ClientCursorConsumed(client_identifier);
CREATE INDEX ClientSequenceClientIdentifier ON ClientSequence(client_identifier);
CREATE INDEX ColorExternalIdentifier on Color(external_id);
CREATE INDEX ConferenceEventId on Conference(owner_id);
CREATE INDEX ConferenceUUID on Conference(uuid);
CREATE INDEX ContactChangesSequenceNumber on ContactChanges(sequence_number);
CREATE INDEX ContactID on Contact(contact_id);
CREATE INDEX EventActionChangesSequenceNumber on EventActionChanges(sequence_number);
CREATE INDEX EventActionEventId on EventAction(event_id);
CREATE INDEX EventActionExternalId on EventAction(external_id);
CREATE INDEX EventActionFolderId on EventAction(external_folder_id);
CREATE INDEX EventExternalIdCalId on CalendarItem(external_id, calendar_id);
CREATE INDEX EventExternalUniqueIdentifierCalId on CalendarItem(unique_identifier, calendar_id);
CREATE INDEX EventHiddenEndDateStartDate on CalendarItem(hidden, end_date, start_date);
CREATE INDEX EventInvitationStatus on CalendarItem(invitation_status);
CREATE INDEX EventStatus on CalendarItem(status);
CREATE INDEX EventUUID on CalendarItem(UUID);
CREATE INDEX ExceptionDateChangesSequenceNumber on ExceptionDateChanges(sequence_number);
CREATE INDEX ExceptionDateOwnerId on ExceptionDate(owner_id);
CREATE UNIQUE INDEX ImageStoreIdentifier on Image(store_id, identifier);
CREATE INDEX LocationAlarmOwnerID on Location(alarm_owner_id) WHERE alarm_owner_id > 0;
CREATE INDEX LocationClientLocOwnerItemId on Location(client_loc_owner_id) WHERE client_loc_owner_id > 0;
CREATE INDEX LocationEndLocOwnerItemId on Location(end_loc_owner_id) WHERE end_loc_owner_id > 0;
CREATE INDEX LocationOwnerItemId on Location(item_owner_id);
CREATE INDEX LocationStartLocOwnerItemId on Location(start_loc_owner_id) WHERE start_loc_owner_id > 0;
CREATE INDEX NotificationCalendarId on Notification(calendar_id);
CREATE INDEX NotificationChangesSequenceNumber on NotificationChanges(sequence_number);
CREATE INDEX NotificationEntityType on Notification(entity_type);
CREATE INDEX NotificationExternalIDCalendarId on Notification(external_id, calendar_id);
CREATE INDEX NotificationUUIDCalendarId on Notification(UUID, calendar_id);
CREATE INDEX OccurrenceCacheCalendarIDDayNextReminderDate on OccurrenceCache(calendar_id, day, next_reminder_date) WHERE next_reminder_date IS NOT NULL;
CREATE INDEX OccurrenceCacheCalendarId on OccurrenceCache(calendar_id);
CREATE INDEX OccurrenceCacheDayEventIdOccurrenceDate on OccurrenceCache(day, event_id, occurrence_date);
CREATE INDEX OccurrenceCacheDaysCount on OccurrenceCacheDays(count);
CREATE INDEX OccurrenceCacheDaysDayCalendarId on OccurrenceCacheDays(day, calendar_id);
CREATE INDEX OccurrenceCacheEarliestPossibleAlarm on OccurrenceCache(earliest_possible_alarm);
CREATE INDEX OccurrenceCacheEventIdOccurrenceDate on OccurrenceCache(event_id, occurrence_date);
CREATE INDEX OccurrenceCacheLatestPossibleAlarm on OccurrenceCache(latest_possible_alarm);
CREATE UNIQUE INDEX OccurrenceCacheOccurrenceDateEventId on OccurrenceCache(occurrence_date, event_id, occurrence_start_date);
CREATE INDEX OwnerID on CategoryLink(owner_id);
CREATE INDEX ParticipantChangesSequenceNumber on ParticipantChanges(sequence_number);
CREATE INDEX ParticipantEmail on Participant(email);
CREATE INDEX ParticipantEntityType on Participant(entity_type);
CREATE INDEX ParticipantIdentityId on Participant(identity_id);
CREATE INDEX ParticipantOwnerId on Participant(owner_id);
CREATE INDEX ParticipantPhoneNumber on Participant(phone_number);
CREATE INDEX ParticipantProposedStartDate on Participant(proposed_start_date);
CREATE INDEX ParticipantUUID on Participant(UUID);
CREATE INDEX RecurrenceChangesSequenceNumber on RecurrenceChanges(sequence_number);
CREATE INDEX RecurrenceEndCountIndex on Recurrence(end_date, count);
CREATE INDEX RecurrenceExternalId on Recurrence(external_id);
CREATE INDEX RecurrenceOwnerIdIndex on Recurrence(owner_id);
CREATE INDEX RecurrenceUUID on Recurrence(UUID);
CREATE INDEX ResourceChangeCalendarID on ResourceChange(calendar_item_id);
CREATE INDEX ResourceChangeCalendarItemID on ResourceChange(calendar_item_id);
CREATE INDEX ResourceChangeIdentityID on ResourceChange(identity_id);
CREATE INDEX ResourceChangeNotificationID on ResourceChange(notification_id);
CREATE INDEX ScheduledTaskCacheDayTaskId on ScheduledTaskCache(day);
CREATE INDEX ScheduledTaskCacheTaskId on ScheduledTaskCache(task_id);
CREATE INDEX ShareeAccessLevel on Sharee(access_level);
CREATE INDEX ShareeChangesSequenceNumber on ShareeChanges(sequence_number);
CREATE INDEX ShareeIdentityId on Sharee(identity_id);
CREATE INDEX ShareeOwnerId on Sharee(owner_id);
CREATE INDEX ShareeStatus on Sharee(status);
CREATE INDEX ShareeUUID on Sharee(UUID);
CREATE INDEX StoreChangesSequenceNumber on StoreChanges(sequence_number);
CREATE INDEX StoreExternalId on Store(external_id);
CREATE INDEX SuggestedEventInfoOwnerId on SuggestedEventInfo(owner_id);
CREATE TRIGGER cascade_alarm_delete AFTER DELETE ON Alarm
BEGIN
DELETE FROM Location WHERE alarm_owner_id = OLD.ROWID AND alarm_owner_id > 0;
END;
CREATE TRIGGER clean_attachments_attachment_file_deleted AFTER DELETE ON AttachmentFile
BEGIN
SELECT CalNoteAttachmentDeleted(OLD.store_id, OLD.UUID);
END;
CREATE TRIGGER clean_attachments_store_deleted AFTER DELETE ON Store
BEGIN
SELECT CalNoteStoreDeleted(OLD.ROWID, OLD.external_id, OLD.persistent_id);
END;
CREATE TRIGGER delete_attachment_file AFTER DELETE ON Attachment
BEGIN
DELETE FROM AttachmentFile WHERE AttachmentFile.ROWID = OLD.file_id AND (SELECT file_id FROM Attachment WHERE file_id = OLD.file_id) IS NULL;
END;
CREATE TRIGGER delete_aux_database_accounts AFTER DELETE ON AuxDatabase
BEGIN
DELETE FROM AuxDatabaseAccount WHERE database_id = OLD.ROWID;
END;
CREATE TRIGGER delete_calendar_members AFTER DELETE ON Calendar
BEGIN
DELETE FROM OccurrenceCacheDays where calendar_id = OLD.ROWID;DELETE FROM OccurrenceCache where calendar_id = OLD.ROWID;DELETE FROM CalendarItem WHERE calendar_id = OLD.ROWID;DELETE FROM OccurrenceCacheDays WHERE count = 0;DELETE FROM Notification WHERE calendar_id = OLD.ROWID; DELETE FROM sharee where owner_id = OLD.ROWID;DELETE FROM Alarm WHERE calendar_owner_id = OLD.ROWID;DELETE FROM Error WHERE calendar_owner_id = OLD.ROWID;DELETE FROM Image WHERE Image.ROWID = OLD.image_id AND (NOT EXISTS (SELECT 1 FROM CalendarItem where CalendarItem.image_id > 0 AND CalendarItem.image_id=OLD.image_id)) AND (NOT EXISTS (SELECT 1 FROM Calendar where Calendar.image_id > 0 AND Calendar.image_id=OLD.image_id));
END;
CREATE TRIGGER delete_category AFTER DELETE ON CategoryLink
BEGIN
DELETE FROM Category WHERE Category.ROWID = OLD.category_id AND NOT EXISTS(SELECT category_id FROM CategoryLink WHERE category_id = OLD.category_id);
END;
CREATE TRIGGER delete_clientcursor_consumed AFTER DELETE ON ClientCursor     BEGIN         DELETE FROM ClientCursorConsumed WHERE client_identifier = OLD.client_identifier;         DELETE FROM ClientSequence WHERE client_identifier = OLD.client_identifier;     END;
CREATE TRIGGER delete_event_alarms_recurs AFTER DELETE ON CalendarItem
BEGIN
DELETE FROM Location WHERE item_owner_id = OLD.ROWID;DELETE FROM Location WHERE start_loc_owner_id > 0 AND start_loc_owner_id = OLD.ROWID;DELETE FROM Location WHERE end_loc_owner_id > 0 AND end_loc_owner_id = OLD.ROWID;DELETE FROM Location WHERE client_loc_owner_id > 0 AND client_loc_owner_id = OLD.ROWID;DELETE FROM Alarm WHERE calendaritem_owner_id = OLD.ROWID;DELETE FROM Recurrence WHERE owner_id = OLD.ROWID;DELETE FROM Participant WHERE owner_id = OLD.ROWID;DELETE FROM ExceptionDate WHERE owner_id = OLD.ROWID;DELETE FROM OccurrenceCache WHERE event_id = OLD.ROWID;DELETE FROM OccurrenceCacheDays WHERE count = 0;DELETE FROM Attachment WHERE owner_id = OLD.ROWID;DELETE FROM ScheduledTaskCache WHERE task_id = OLD.ROWID;DELETE FROM EventAction WHERE event_id = OLD.ROWID;DELETE FROM SuggestedEventInfo WHERE ROWID = OLD.suggested_event_info_id;DELETE FROM Error WHERE ROWID = OLD.error_id;DELETE FROM CategoryLink WHERE owner_id = OLD.ROWID;DELETE FROM Image WHERE Image.ROWID = OLD.image_id AND (NOT EXISTS (SELECT 1 FROM CalendarItem where CalendarItem.image_id > 0 AND CalendarItem.image_id=OLD.image_id)) AND (NOT EXISTS (SELECT 1 FROM Calendar where Calendar.image_id > 0 AND Calendar.image_id=OLD.image_id)); DELETE FROM Color WHERE Color.ROWID = OLD.color_id AND (NOT EXISTS (SELECT 1 FROM CalendarItem where CalendarItem.color_id > 0 AND CalendarItem.color_id=OLD.color_id));
END;
CREATE TRIGGER delete_from_alarm_cache_after_delete_alarm AFTER DELETE ON Alarm
BEGIN
DELETE From AlarmCache WHERE alarm_id = OLD.ROWID;
END;
CREATE TRIGGER delete_notification_calendar AFTER DELETE ON ResourceChange
BEGIN
DELETE FROM ResourceChange WHERE calendar_id NOT IN (SELECT ROWID FROM Calendar);
END;
CREATE TRIGGER delete_resource_changes_for_notification AFTER DELETE ON Notification
BEGIN
DELETE FROM ResourceChange WHERE notification_id NOT IN (SELECT ROWID FROM Notification WHERE entity_type = 17 OR entity_type = 19);
END;
CREATE TRIGGER delete_store_changes AFTER DELETE ON Store
BEGIN
DELETE FROM CalendarChanges WHERE store_id = OLD.ROWID;DELETE FROM CalendarItemChanges WHERE store_id = OLD.ROWID;DELETE FROM AlarmChanges WHERE store_id = OLD.ROWID;DELETE FROM RecurrenceChanges WHERE store_id = OLD.ROWID;DELETE FROM ParticipantChanges WHERE store_id = OLD.ROWID;DELETE FROM AttachmentChanges WHERE store_id = OLD.ROWID;DELETE FROM ContactChanges WHERE store_id = OLD.ROWID;DELETE FROM EventActionChanges WHERE store_id = OLD.ROWID;DELETE FROM ExceptionDateChanges WHERE store_id = OLD.ROWID;DELETE FROM NotificationChanges WHERE store_id = OLD.ROWID;DELETE FROM ShareeChanges WHERE store_id = OLD.ROWID;DELETE FROM ClientCursor WHERE store_id = OLD.ROWID;
END;
CREATE TRIGGER delete_store_members AFTER DELETE ON Store
BEGIN
DELETE FROM Calendar WHERE store_id = OLD.ROWID;
DELETE FROM Error WHERE ROWID = OLD.error_id;
END;
CREATE TRIGGER update_cache_days_after_delete AFTER DELETE ON OccurrenceCache
BEGIN
UPDATE OccurrenceCacheDays SET count = count - 1 WHERE day = OLD.day AND calendar_id = OLD.calendar_id AND OLD.next_reminder_date IS NULL;UPDATE OccurrenceCacheDays SET count = count - 1 WHERE day = OLD.day AND calendar_id = -2 AND OLD.next_reminder_date IS NULL;
END;
CREATE TRIGGER update_cache_days_after_insert AFTER INSERT ON OccurrenceCache
BEGIN
REPLACE INTO OccurrenceCacheDays VALUES (NEW.calendar_id, NEW.store_id, NEW.day, IIF(NEW.next_reminder_date IS NULL, 1, 0) + IFNULL((SELECT count FROM OccurrenceCacheDays WHERE day = NEW.day AND calendar_id = NEW.calendar_id), 0));
REPLACE INTO OccurrenceCacheDays VALUES (-2, -2, NEW.day, IIF(NEW.next_reminder_date IS NULL, 1, 0) + IFNULL((SELECT count FROM OccurrenceCacheDays WHERE day = NEW.day AND calendar_id = -2), 0));
END;
CREATE TRIGGER update_cache_days_after_update AFTER UPDATE OF day ON OccurrenceCache
BEGIN
REPLACE INTO OccurrenceCacheDays VALUES (NEW.calendar_id, NEW.store_id, NEW.day, IIF(NEW.next_reminder_date IS NULL, 1, 0) + IFNULL((SELECT count FROM OccurrenceCacheDays WHERE day = NEW.day AND calendar_id = NEW.calendar_id), 0));
REPLACE INTO OccurrenceCacheDays VALUES (-2, -2, NEW.day, IIF(NEW.next_reminder_date IS NULL, 1, 0) + IFNULL((SELECT count FROM OccurrenceCacheDays WHERE day = NEW.day AND calendar_id = -2), 0));
UPDATE OccurrenceCacheDays SET count = count - 1 WHERE day = OLD.day AND calendar_id = OLD.calendar_id AND OLD.next_reminder_date IS NULL;UPDATE OccurrenceCacheDays SET count = count - 1 WHERE day = OLD.day AND calendar_id = -2 AND OLD.next_reminder_date IS NULL;
END;
CREATE TRIGGER update_task_cache_count_after_insert AFTER INSERT ON ScheduledTaskCache
BEGIN
    REPLACE INTO ScheduledTaskCache VALUES (NEW.day, NULL, NULL, -2, 1 + IFNULL((SELECT count FROM ScheduledTaskCache WHERE day = NEW.day AND task_id = -2), 0));
END;
CREATE TRIGGER update_task_cache_count_after_update AFTER UPDATE OF day ON ScheduledTaskCache
BEGIN
    UPDATE ScheduledTaskCache SET count = count - 1 WHERE day = OLD.day AND task_id = -2;
    REPLACE INTO ScheduledTaskCache VALUES (NEW.day, NULL, NULL, -2, IFNULL((SELECT count FROM ScheduledTaskCache WHERE day = NEW.day AND task_id = -2), 0));
    DELETE FROM ScheduledTaskCache WHERE day = OLD.day AND count = 0;
END;
CREATE TRIGGER update_task_cache_days_after_delete AFTER DELETE ON ScheduledTaskCache
BEGIN
    UPDATE ScheduledTaskCache SET count = count - 1 WHERE day = OLD.day AND task_id = -2;
    DELETE FROM ScheduledTaskCache WHERE day = OLD.day AND count = 0;
END;
