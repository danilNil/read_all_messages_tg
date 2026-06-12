from datetime import datetime, timezone
import asyncio
from contextlib import contextmanager
import json
import os
import sys
import time

from dotenv import load_dotenv

try:
    import fcntl
except ImportError:
    fcntl = None


script_dir = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(script_dir, ".env"))


def write_result(**result):
    payload = {
        "hasUnreadInbox": False,
        "unreadDialogCount": 0,
        "checkedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "error": None,
    }
    payload.update(result)
    print(json.dumps(payload, ensure_ascii=False))


@contextmanager
def telegram_session_lock(timeout_seconds=None):
    lock_path = os.path.join(script_dir, "session_name.lock")
    lock_file = open(lock_path, "w", encoding="utf-8")

    if fcntl is None:
        try:
            yield
        finally:
            lock_file.close()
        return

    started_at = time.monotonic()
    while True:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except BlockingIOError:
            if timeout_seconds is not None and time.monotonic() - started_at >= timeout_seconds:
                lock_file.close()
                raise TimeoutError("Telegram session is busy; reader may be running")
            time.sleep(0.2)

    try:
        yield
    finally:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


def get_dialog_type(dialog):
    entity = getattr(dialog, "entity", None)
    if getattr(entity, "bot", False):
        return "bot"
    if getattr(entity, "broadcast", False):
        return "channel"
    if getattr(entity, "megagroup", False):
        return "group"
    if getattr(entity, "forum", False):
        return "forum"
    if getattr(entity, "first_name", None) or getattr(entity, "last_name", None):
        return "private"
    return type(entity).__name__


def get_read_state(dialog):
    raw_dialog = getattr(dialog, "dialog", None)
    message = getattr(dialog, "message", None)
    return {
        "topMessageId": getattr(message, "id", None),
        "readInboxMaxId": getattr(raw_dialog, "read_inbox_max_id", None),
    }


def has_unread_top_message(dialog):
    state = get_read_state(dialog)
    top_message_id = state["topMessageId"]
    read_inbox_max_id = state["readInboxMaxId"]

    if top_message_id is None or read_inbox_max_id is None:
        return True

    return top_message_id > read_inbox_max_id


async def main():
    try:
        from telethon import TelegramClient, functions
    except ModuleNotFoundError as e:
        write_result(error=f"Missing Python dependency: {e.name}")
        return 1

    api_id = os.getenv("API_ID")
    api_hash = os.getenv("API_HASH")
    phone_number = os.getenv("PHONE_NUMBER")

    if not all([api_id, api_hash, phone_number]):
        write_result(error="Missing API_ID, API_HASH, or PHONE_NUMBER in .env")
        return 1

    include_forum_topics = os.getenv("CHECK_FORUM_TOPICS", "").lower() in {
        "1",
        "true",
        "yes",
    }

    client = TelegramClient(os.path.join(script_dir, "session_name"), api_id, api_hash)
    unread_dialogs = []

    try:
        with telegram_session_lock(timeout_seconds=3):
            await client.start(phone_number)

            async for dialog in client.iter_dialogs(archived=False):
                if getattr(dialog, "archived", False):
                    continue

                unread_count = getattr(dialog, "unread_count", 0)
                if unread_count > 0:
                    if not has_unread_top_message(dialog):
                        continue

                    read_state = get_read_state(dialog)
                    unread_dialogs.append(
                        {
                            "title": dialog.title,
                            "unreadCount": unread_count,
                            "muted": bool(getattr(dialog, "muted", False)),
                            "archived": bool(getattr(dialog, "archived", False)),
                            "folderId": getattr(getattr(dialog, "dialog", None), "folder_id", None),
                            "type": get_dialog_type(dialog),
                            "topMessageId": read_state["topMessageId"],
                            "readInboxMaxId": read_state["readInboxMaxId"],
                            "reason": "dialog.unread_count",
                        }
                    )
                    continue

                entity = getattr(dialog, "entity", None)
                if not include_forum_topics or not getattr(entity, "forum", False):
                    continue

                try:
                    topics_result = await client(
                        functions.channels.GetForumTopicsRequest(
                            channel=entity,
                            offset_date=datetime.utcnow(),
                            offset_id=0,
                            offset_topic=0,
                            limit=100,
                        )
                    )
                    topics = getattr(topics_result, "topics", [])
                    unread_topics = [
                        topic
                        for topic in topics
                        if getattr(topic, "unread_count", 0) > 0
                    ]
                    if unread_topics:
                        unread_dialogs.append(
                            {
                                "title": dialog.title,
                                "unreadCount": sum(
                                    getattr(topic, "unread_count", 0)
                                    for topic in unread_topics
                                ),
                                "muted": bool(getattr(dialog, "muted", False)),
                                "archived": bool(getattr(dialog, "archived", False)),
                                "folderId": getattr(getattr(dialog, "dialog", None), "folder_id", None),
                                "type": get_dialog_type(dialog),
                                "reason": "forum_topics",
                            }
                        )
                except Exception:
                    # If a forum topic check fails, keep the top-level dialog result.
                    continue

        write_result(
            hasUnreadInbox=len(unread_dialogs) > 0,
            unreadDialogCount=len(unread_dialogs),
            unreadDialogs=unread_dialogs[:20],
            includeForumTopics=include_forum_topics,
        )
        return 0
    except Exception as e:
        write_result(error=str(e))
        return 1
    finally:
        await client.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
