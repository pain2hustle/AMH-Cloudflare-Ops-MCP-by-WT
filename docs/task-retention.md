# Task board retention

Austin selected seven days on 2026-10-19. The live bundle compacts done-task details into a bounded receipt after seven days, on read or a daily Durable Object alarm. The receipt retains task identity, timestamps, agent, a short result, evidence links and recorded usage. Open/claimed/failed tasks and legacy done results explicitly marked blocked or pending never expire. No owner-chat, project file or media deletion is included.

Cleanup is idempotent and processes at most 200 records per alarm, scheduling another pass after one minute if needed. Existing migration alarms are preserved. list_tasks/my_tasks returns retention metadata and next_alarm for verification. Retained receipts are history and should only be read when relevant.
