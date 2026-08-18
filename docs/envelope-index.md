# Envelope Index — observed schema

Regenerate with `node scripts/probe-envelope-index.mjs --write` on each new macOS release.
Output is redacted: DDL, counts and booleans only.

|                         |                |
| ----------------------- | -------------- |
| macOS                   | 26.6           |
| Mail data version       | V10            |
| Schema fingerprint      | `77aa2cd3a55b` |
| SQLite                  | 3.53.3         |
| Epoch offset            | 0              |
| `labels` table          | true           |
| ROWID == AppleScript id | true           |
| immutable=1 skips WAL   | true           |

## Full document

```json
{
  "probeVersion": 1,
  "ranAt": "2026-08-18T06:45:58.072Z",
  "platform": "darwin arm64",
  "node": "v24.18.0",
  "macos": "26.6",
  "sqlite": "3.53.3",
  "findings": {
    "accounts": [
      {
        "id": "98AC2C3D-408C-47E4-8FE4-6E64D1F58E99",
        "enabled": true,
        "dir": "/Users/olivier/Library/Mail/V10/98AC2C3D-408C-47E4-8FE4-6E64D1F58E99",
        "messageCaching": "all messages and their attachments",
        "mailboxCount": 9,
        "nameLength": 6
      },
      {
        "id": "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D",
        "enabled": true,
        "dir": "/Users/olivier/Library/Mail/V10/0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D",
        "messageCaching": "all messages and their attachments",
        "mailboxCount": 15,
        "nameLength": 7
      },
      {
        "id": "20FF3390-EC73-43C6-B965-BE5E5FB7C508",
        "enabled": true,
        "dir": "/Users/olivier/Library/Mail/V10/20FF3390-EC73-43C6-B965-BE5E5FB7C508",
        "messageCaching": "all messages and their attachments",
        "mailboxCount": 13,
        "nameLength": 6
      },
      {
        "id": "69A08273-9987-4459-994B-F7153421A652",
        "enabled": true,
        "dir": "/Users/olivier/Library/Mail/V10/69A08273-9987-4459-994B-F7153421A652",
        "messageCaching": null,
        "mailboxCount": 11,
        "nameLength": 4
      }
    ],
    "locate": {
      "viaAccountDirectory": "/Users/olivier/Library/Mail/V10",
      "viaGlob": "/Users/olivier/Library/Mail/V10",
      "globReadable": true,
      "agree": true,
      "vNumber": "V10"
    },
    "index": {
      "path": "~/Library/Mail/V10/MailData/Envelope Index",
      "exists": true,
      "readable": true,
      "size": 437256192,
      "mtime": "2026-08-18T06:08:27.192Z",
      "wal": {
        "exists": true,
        "readable": true,
        "size": 2051792,
        "mtime": "2026-08-18T06:44:32.684Z"
      },
      "shm": {
        "exists": true,
        "readable": true,
        "size": 32768,
        "mtime": "2026-08-15T07:48:38.329Z"
      }
    },
    "fullDiskAccess": "GRANTED",
    "open": {
      "ro": {
        "ok": true,
        "maxRowid": 198598,
        "messageCount": 181427,
        "ms": 11
      },
      "immutable": {
        "ok": true,
        "maxRowid": 198597,
        "messageCount": 181426,
        "ms": 5
      },
      "walIsBeingSkipped": true
    },
    "schema": {
      "fingerprint": "77aa2cd3a55b",
      "tableCount": 54,
      "tables": {
        "action_flags": {
          "columns": ["ROWID", "action", "flag_type", "flag_value"],
          "rows": 0
        },
        "action_labels": {
          "columns": ["ROWID", "action", "do_add", "label"],
          "rows": 0
        },
        "action_messages": {
          "columns": [
            "ROWID",
            "action",
            "action_phase",
            "message",
            "remote_id",
            "destination_message"
          ],
          "rows": 0
        },
        "additional_remote_content_links": {
          "columns": ["ROWID", "url", "requests", "last_seen_date", "last_request_date"],
          "rows": 0
        },
        "address_metadata": {
          "columns": ["ROWID", "address", "smime_capabilities", "smime_capabilities_date"],
          "rows": 0
        },
        "addresses": {
          "columns": ["ROWID", "address", "comment"],
          "rows": 32813
        },
        "attachments": {
          "columns": ["ROWID", "message", "attachment_id", "name"],
          "rows": 52128
        },
        "brand_indicator_evidence": {
          "columns": ["ROWID", "brand_indicator", "url", "evidence", "unverified_messages"],
          "rows": 92
        },
        "brand_indicators": {
          "columns": ["ROWID", "url", "indicator", "indicator_hash", "hash_algorithm"],
          "rows": 79
        },
        "business_addresses": {
          "columns": ["ROWID", "address", "business", "category", "last_modified", "last_bcs_sync"],
          "rows": 23830
        },
        "business_categories": {
          "columns": ["ROWID", "business", "category"],
          "rows": 2
        },
        "businesses": {
          "columns": ["ROWID", "address_comment", "domain", "brand_id", "localized_brand_name"],
          "rows": 18194
        },
        "conversation_id_message_id": {
          "columns": ["conversation_id", "message_id", "date_sent"],
          "rows": 184589
        },
        "conversations": {
          "columns": ["conversation_id", "flags", "sync_key"],
          "rows": 149472
        },
        "data_detection_results": {
          "columns": ["ROWID", "global_message_id", "category", "value"],
          "rows": 0
        },
        "duplicates_unread_count": {
          "columns": ["ROWID", "message_id", "mailbox_id", "unread_count"],
          "rows": 44546
        },
        "events": {
          "columns": [
            "ROWID",
            "message_id",
            "start_date",
            "end_date",
            "location",
            "out_of_date",
            "processed",
            "is_all_day",
            "associated_id_string",
            "original_receiving_account",
            "ical_uid",
            "is_response_requested"
          ],
          "rows": 59
        },
        "ews_folders": {
          "columns": ["ROWID", "folder_id", "mailbox_id", "sync_state"],
          "rows": 11
        },
        "generated_summaries": {
          "columns": ["ROWID", "summary", "status"],
          "rows": 8126
        },
        "indexing_analytics_attachment_donations_enqueued": {
          "columns": ["id", "item", "source", "started_at", "ended_at", "error"],
          "rows": 0
        },
        "indexing_analytics_attachment_donations_identified": {
          "columns": ["id", "item", "reason", "started_at", "recorded", "ended_at"],
          "rows": 0
        },
        "indexing_analytics_batches": {
          "columns": [
            "id",
            "started_at",
            "messages_count",
            "attachments_count",
            "rich_links_count",
            "ended_at",
            "error_code",
            "error_domain"
          ],
          "rows": 0
        },
        "indexing_analytics_dropped_index_events": {
          "columns": ["id", "timestamp"],
          "rows": 0
        },
        "indexing_analytics_message_donations_enqueued": {
          "columns": ["id", "item", "source", "started_at", "ended_at", "error"],
          "rows": 0
        },
        "indexing_analytics_message_donations_identified": {
          "columns": ["id", "item", "reason", "started_at", "recorded", "ended_at"],
          "rows": 0
        },
        "indexing_analytics_rich_link_donations_enqueued": {
          "columns": ["id", "item", "source", "started_at", "ended_at", "error"],
          "rows": 0
        },
        "indexing_analytics_rich_link_donations_identified": {
          "columns": ["id", "item", "reason", "started_at", "recorded", "ended_at"],
          "rows": 0
        },
        "labels": {
          "columns": ["message_id", "mailbox_id"],
          "rows": 197951
        },
        "last_spotlight_check_date": {
          "columns": ["message_id", "date"],
          "rows": 0
        },
        "local_message_actions": {
          "columns": [
            "ROWID",
            "mailbox",
            "source_mailbox",
            "destination_mailbox",
            "action_type",
            "user_initiated"
          ],
          "rows": 0
        },
        "mailbox_actions": {
          "columns": [
            "ROWID",
            "account_identifier",
            "action_type",
            "mailbox_name",
            "mailbox",
            "new_mailbox_name"
          ],
          "rows": 0
        },
        "mailboxes": {
          "columns": [
            "ROWID",
            "url",
            "total_count",
            "unread_count",
            "deleted_count",
            "unseen_count",
            "unread_count_adjusted_for_duplicates",
            "change_identifier",
            "source",
            "alleged_change_identifier"
          ],
          "rows": 50
        },
        "message_global_data": {
          "columns": [
            "ROWID",
            "message_id",
            "follow_up_start_date",
            "follow_up_end_date",
            "follow_up_jsonstringformodelevaluationforsuggestions",
            "download_state",
            "read_later_date",
            "send_later_date",
            "validation_state",
            "model_category",
            "model_subcategory",
            "category_model_version",
            "category_is_temporary",
            "model_analytics",
            "model_high_impact",
            "generated_summary",
            "urgent",
            "message_id_header"
          ],
          "rows": 179910
        },
        "message_metadata": {
          "columns": ["message_id", "timestamp", "json_values"],
          "rows": 0
        },
        "message_references": {
          "columns": ["ROWID", "message", "reference", "is_originator"],
          "rows": 98765
        },
        "message_rich_links": {
          "columns": ["global_message_id", "rich_link"],
          "rows": 2
        },
        "messages": {
          "columns": [
            "ROWID",
            "message_id",
            "global_message_id",
            "remote_id",
            "document_id",
            "sender",
            "subject_prefix",
            "subject",
            "summary",
            "date_sent",
            "date_received",
            "mailbox",
            "remote_mailbox",
            "flags",
            "read",
            "flagged",
            "deleted",
            "size",
            "conversation_id",
            "date_last_viewed",
            "list_id_hash",
            "unsubscribe_type",
            "searchable_message",
            "brand_indicator",
            "display_date",
            "flag_color",
            "is_urgent",
            "color",
            "type",
            "fuzzy_ancestor",
            "automated_conversation",
            "root_status"
          ],
          "rows": 181427
        },
        "properties": {
          "columns": ["ROWID", "key", "value"],
          "rows": 10
        },
        "protected_message_data": {
          "columns": ["ROWID", "data"],
          "rows": 0
        },
        "recipients": {
          "columns": ["ROWID", "message", "address", "type", "position"],
          "rows": 287734
        },
        "remote_content_links": {
          "columns": ["ROWID", "url", "requests", "last_seen_date", "last_request_date"],
          "rows": 5104
        },
        "rich_links": {
          "columns": ["ROWID", "title", "url", "hash"],
          "rows": 3
        },
        "searchable_attachments": {
          "columns": ["attachment_id", "attachment", "message_id", "transaction_id"],
          "rows": 10184
        },
        "searchable_data_detection_results": {
          "columns": ["ROWID", "data_detection_result", "message", "transaction_id"],
          "rows": 0
        },
        "searchable_message_tombstones": {
          "columns": ["ROWID", "type", "identifier", "transaction_id"],
          "rows": 0
        },
        "searchable_messages": {
          "columns": [
            "message_id",
            "message",
            "transaction_id",
            "message_body_indexed",
            "reindex_type"
          ],
          "rows": 181425
        },
        "searchable_rich_links": {
          "columns": ["rich_link_id", "rich_link", "message_id", "transaction_id"],
          "rows": 4
        },
        "sender_addresses": {
          "columns": ["address", "sender"],
          "rows": 199
        },
        "senders": {
          "columns": ["ROWID", "contact_identifier", "bucket", "user_initiated"],
          "rows": 141
        },
        "server_labels": {
          "columns": ["server_message", "label"],
          "rows": 197951
        },
        "server_messages": {
          "columns": [
            "ROWID",
            "message",
            "mailbox",
            "sequence_identifier",
            "read",
            "deleted",
            "replied",
            "flagged",
            "draft",
            "forwarded",
            "redirected",
            "junk_level_set_by_user",
            "junk_level",
            "flag_color",
            "remote_id"
          ],
          "rows": 178957
        },
        "sqlite_sequence": {
          "columns": ["name", "seq"],
          "rows": 18
        },
        "subjects": {
          "columns": ["ROWID", "subject"],
          "rows": 116448
        },
        "summaries": {
          "columns": ["ROWID", "summary"],
          "rows": 30614
        }
      },
      "missingRequired": [],
      "has": {
        "labels": true,
        "recipients": true,
        "attachments": true,
        "summaries": true,
        "subjects": true,
        "addresses": true,
        "conversationColumn": "conversation_id",
        "flaggedColumn": true,
        "dateSentColumn": true
      }
    },
    "epoch": {
      "maxDateReceivedRaw": 1787035201,
      "detectedOffset": 0,
      "why": "raw value lands within 10 years of now",
      "asIso": "2026-08-18T06:40:01.000Z"
    },
    "mailboxUrls": {
      "count": 50,
      "schemes": ["ews", "imap", "local"],
      "hostIsAccountUuid": {
        "yes": 47,
        "no": 3
      },
      "samplePaths": [
        "Archive",
        "Conversation History",
        "Deleted Items",
        "Drafts",
        "Inbox",
        "Journal",
        "Junk Email",
        "Notes",
        "Outbox",
        "Sent Items",
        "Tasks",
        "[Gmail]/All Mail",
        "[Gmail]/Drafts",
        "[Gmail]/Important",
        "[Gmail]/Sent Mail",
        "[Gmail]/Spam",
        "[Gmail]/Starred",
        "[Gmail]/Trash",
        "Carlipa",
        "Forums",
        "INBOX",
        "Invoices",
        "Promotions",
        "Social",
        "Updates",
        "Deleted Messages",
        "Junk",
        "Sent Messages",
        "Trading",
        "Recovered Messages (Magenta)",
        "SendLater"
      ]
    },
    "rowidBridge": {
      "attempted": true,
      "sampleSize": 5,
      "resolveError": null,
      "comparisons": [
        {
          "found": true,
          "subjectMatches": true,
          "subjectLengths": [83, 83],
          "dateDeltaSeconds": 0
        },
        {
          "found": true,
          "subjectMatches": true,
          "subjectLengths": [36, 36],
          "dateDeltaSeconds": 0
        },
        {
          "found": true,
          "subjectMatches": true,
          "subjectLengths": [80, 80],
          "dateDeltaSeconds": 0
        },
        {
          "found": true,
          "subjectMatches": true,
          "subjectLengths": [76, 76],
          "dateDeltaSeconds": 0
        },
        {
          "found": true,
          "subjectMatches": true,
          "subjectLengths": [48, 48],
          "dateDeltaSeconds": 0
        }
      ],
      "allFound": true,
      "allSubjectsMatch": true,
      "allDatesClose": true,
      "VERDICT": true
    },
    "emlx": {
      "mailboxDirFound": true,
      "derived": [
        {
          "rowid": 198594,
          "shard": "8/9/1",
          "hit": true
        },
        {
          "rowid": 198591,
          "shard": "8/9/1",
          "hit": true
        },
        {
          "rowid": 198587,
          "shard": "8/9/1",
          "hit": true
        },
        {
          "rowid": 198585,
          "shard": "8/9/1",
          "hit": true
        },
        {
          "rowid": 198583,
          "shard": "8/9/1",
          "hit": true
        }
      ],
      "messagesDirCount": null,
      "innerEntries": ["B6CE5937-6BD6-447C-B6DF-4762D2537363", "Info.plist"],
      "derivedHitRate": "5/5"
    },
    "gmail": {
      "checked": 2,
      "checks": [
        {
          "accountId": "0F5CB1CC-7912-4AAE-90EA-4D28AD6DD98D",
          "mailboxRowid": 10,
          "viaFk": 0,
          "viaLabels": 51128,
          "viaAppleScript": 51128
        },
        {
          "accountId": "20FF3390-EC73-43C6-B965-BE5E5FB7C508",
          "mailboxRowid": 26,
          "viaFk": 0,
          "viaLabels": 16325,
          "viaAppleScript": 16325
        }
      ]
    }
  },
  "notes": []
}
```
