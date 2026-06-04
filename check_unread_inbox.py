from datetime import datetime, timezone
import asyncio
import json
import os
import sys

from dotenv import load_dotenv


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

    client = TelegramClient(os.path.join(script_dir, "session_name"), api_id, api_hash)
    unread_dialog_count = 0

    try:
        await client.start(phone_number)

        async for dialog in client.iter_dialogs(archived=False):
            if getattr(dialog, "archived", False):
                continue

            if getattr(dialog, "unread_count", 0) > 0:
                unread_dialog_count += 1
                continue

            entity = getattr(dialog, "entity", None)
            if not getattr(entity, "forum", False):
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
                if any(getattr(topic, "unread_count", 0) > 0 for topic in topics):
                    unread_dialog_count += 1
            except Exception:
                # If a forum topic check fails, keep the top-level dialog result.
                continue

        write_result(
            hasUnreadInbox=unread_dialog_count > 0,
            unreadDialogCount=unread_dialog_count,
        )
        return 0
    except Exception as e:
        write_result(error=str(e))
        return 1
    finally:
        await client.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
