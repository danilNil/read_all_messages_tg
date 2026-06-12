from datetime import datetime
import asyncio
from contextlib import contextmanager
import json
import logging
import logging.handlers
import os
import sys
import time
from dotenv import load_dotenv

try:
    import fcntl
except ImportError:
    fcntl = None

# Load environment variables
load_dotenv()

# Single rotating log file (max 1MB, keep 2 backups = 3 files total)
script_dir = os.path.dirname(os.path.abspath(__file__))
log_filename = os.path.join(script_dir, 'telegram_reader.log')
status_filename = os.path.join(script_dir, 'reader_status.json')
file_handler = logging.handlers.RotatingFileHandler(
    log_filename, maxBytes=1024 * 1024, backupCount=2, encoding='utf-8'
)
file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
stream_handler = logging.StreamHandler()
stream_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

logging.basicConfig(level=logging.INFO, handlers=[file_handler, stream_handler])
logger = logging.getLogger(__name__)

try:
    from telethon import TelegramClient, functions, types
    from telethon.tl.functions.stories import GetAllStoriesRequest, ReadStoriesRequest
except ModuleNotFoundError as e:
    logger.exception(
        "Missing Python dependency '%s'. Install dependencies with: %s -m pip install -r %s",
        e.name,
        sys.executable,
        os.path.join(script_dir, 'requirements.txt'),
    )
    raise SystemExit(1)
except Exception:
    logger.exception("Failed to import Telegram libraries")
    raise SystemExit(1)

# Clean up old timestamped log files (from previous setup - no longer created)
for f in os.listdir(script_dir):
    if f.startswith('telegram_reader_') and f.endswith('.log'):
        try:
            filepath = os.path.join(script_dir, f)
            if os.path.isfile(filepath):
                os.remove(filepath)
        except OSError:
            pass

# Get credentials from environment variables
api_id = os.getenv('API_ID')
api_hash = os.getenv('API_HASH')
phone_number = os.getenv('PHONE_NUMBER')

if not all([api_id, api_hash, phone_number]):
    logger.error("Missing required environment variables. Please check your .env file")
    exit(1)

# Создание клиента
session_path = os.path.join(script_dir, 'session_name')
client = TelegramClient(session_path, api_id, api_hash)


def write_archive_status(**status):
    payload = {
        "archiveLastReadAt": datetime.utcnow().isoformat(timespec='seconds') + "Z",
        "archiveProcessedDialogCount": 0,
        "archiveError": None,
    }
    payload.update(status)

    tmp_filename = f"{status_filename}.tmp"
    with open(tmp_filename, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    os.replace(tmp_filename, status_filename)


@contextmanager
def telegram_session_lock(timeout_seconds=None):
    """Prevent concurrent Telethon sqlite session access."""
    lock_path = os.path.join(script_dir, 'session_name.lock')
    lock_file = open(lock_path, 'w', encoding='utf-8')

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
                raise TimeoutError('Telegram session is busy')
            time.sleep(0.2)

    try:
        yield
    finally:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        lock_file.close()


async def process_forum_topics(dialog):
    """Mark all unread messages in forum topics (Threads) as read."""
    entity = dialog.entity
    logger.info(f'Chat {dialog.title} is a forum (has topics). Processing topics...')

    async def mark_history_read(reason):
        logger.info(f'{reason} for {dialog.title}, using ReadHistory fallback')
        try:
            last_msg = await client.get_messages(entity, limit=1)
            max_id = last_msg[0].id if last_msg else 0
            if max_id <= 0:
                logger.warning(f"No messages in {dialog.title} to mark as read")
                return

            try:
                await mark_dialog_read(dialog, max_id=max_id)
                return
            except Exception as e:
                logger.error(f"Dialog read fallback failed for {dialog.title}: {e}")

            try:
                await client(functions.channels.ReadHistoryRequest(
                    channel=entity,
                    max_id=max_id
                ))
            except Exception:
                await client(functions.messages.ReadHistoryRequest(
                    peer=entity,
                    max_id=max_id
                ))
            logger.info(f"Marked {dialog.title} as read (fallback)")
        except Exception as e:
            logger.error(f"ReadHistory fallback failed for {dialog.title}: {e}")

    try:
        # offset_date в будущем = начать с последних топиков (по API)
        topics_result = await client(functions.channels.GetForumTopicsRequest(
            channel=entity,
            offset_date=datetime.utcnow(),
            offset_id=0,
            offset_topic=0,
            limit=100
        ))
        topics = getattr(topics_result, 'topics', [])
        logger.info(f'Found {len(topics)} topics in forum {dialog.title}')

        if topics:
            processed_topics = 0
            for topic in topics:
                if topic.unread_count <= 0:
                    continue
                logger.info(
                    f"Processing topic '{topic.title}' in chat {dialog.title} "
                    f"(Unread in topic: {topic.unread_count})"
                )
                try:
                    # msg_id = topic starter msg id (topic.id = messageActionTopicCreate id for forums)
                    await client(functions.messages.ReadDiscussionRequest(
                        peer=entity,
                        msg_id=topic.id,
                        read_max_id=topic.top_message
                    ))
                    processed_topics += 1
                    logger.info(f"Marked topic '{topic.title}' in chat {dialog.title} as read")
                    await asyncio.sleep(0.5)
                except Exception as e:
                    logger.error(f"Failed to mark topic '{topic.title}' in chat {dialog.title} as read: {e}")

            if processed_topics == 0 and dialog.unread_count > 0:
                await mark_history_read('No unread topics matched top-level unread count')
        else:
            # GetForumTopics вернул 0 (монoфорум или др.) — помечаем весь канал как прочитанный
            await mark_history_read('No topics from API')
    except Exception as e:
        logger.error(f"Error processing forum topics in chat {dialog.title}: {e}")


async def clear_unread_mark(dialog):
    """Clear Telegram's manual "mark as unread" flag when present."""
    try:
        input_entity = await client.get_input_entity(dialog.entity)
        await client(functions.messages.MarkDialogUnreadRequest(
            peer=types.InputDialogPeer(input_entity),
            unread=False
        ))
        logger.info(f"Cleared unread marker for {dialog.title}")
    except Exception as e:
        logger.warning(f"Failed to clear unread marker for {dialog.title}: {e}")


async def mark_dialog_read(dialog, max_id=None):
    """Mark a dialog read at dialog level, not message-by-message."""
    if max_id is None:
        last_msg = await client.get_messages(dialog.entity, limit=1)
        max_id = last_msg[0].id if last_msg else 0

    if max_id > 0:
        await client.send_read_acknowledge(dialog.entity, max_id=max_id)
        logger.info(f"Marked {dialog.title} history as read up to message {max_id}")
    else:
        logger.warning(f"No messages in {dialog.title} to mark as read")

    await clear_unread_mark(dialog)


async def process_regular_chat(dialog):
    """Mark unread messages in a regular chat as read (skip mentions)."""
    skipped_mentions = 0
    max_id = 0

    async for message in client.iter_messages(dialog.entity, limit=max(dialog.unread_count, 1)):
        try:
            if getattr(message, 'mentioned', False):
                logger.info(f'Skipping message with mention from chat {dialog.title}')
                skipped_mentions += 1
                continue
            max_id = max(max_id, message.id)
            date = message.date.strftime("%Y-%m-%d %H:%M:%S")
            sender = "Unknown"
            if hasattr(message.sender, 'first_name'):
                sender = message.sender.first_name
                if message.sender.last_name:
                    sender += f" {message.sender.last_name}"
            elif hasattr(message.sender, 'title'):
                sender = message.sender.title
            logger.info(f'Reading message from {sender} at {date}: {(message.text or "")[:100]}...')
        except Exception as e:
            logger.error(f"Error processing message: {e}")

    if max_id > 0:
        await mark_dialog_read(dialog, max_id=max_id)
    elif skipped_mentions == 0:
        await mark_dialog_read(dialog)


async def main():
    # Вход в аккаунт
    await client.start(phone_number)
    logger.info("Successfully logged into Telegram")
    
    # Получаем информацию о текущем пользователе
    me = await client.get_me()
    my_username = me.username
    my_id = me.id
    logger.info(f"Logged in as {my_username} (ID: {my_id})")

    # Получение и чтение историй (stories)
    logger.info("Starting to read stories...")
    try:
        # Получаем все доступные истории
        stories_result = await client(GetAllStoriesRequest(
            state=None,  # Получаем все истории
            next=False
        ))
        
        if hasattr(stories_result, 'stories') and stories_result.stories:
            logger.info(f'Found {len(stories_result.stories)} stories')
            
            for story_item in stories_result.stories:
                try:
                    peer = story_item.peer
                    story = story_item.story
                    
                    # Форматируем дату истории
                    date = story.date.strftime("%Y-%m-%d %H:%M:%S")
                    
                    # Получаем текст истории, если он есть
                    story_text = story.caption if hasattr(story, 'caption') else ''
                    
                    logger.info(f'Reading story from {date}: {story_text[:100]}...')
                    
                    try:
                        # Помечаем историю как просмотренную
                        await client(ReadStoriesRequest(
                            peer=peer,
                            max_id=story.id
                        ))
                        logger.info(f'Marked story as read')
                        await asyncio.sleep(0.5)
                    except Exception as e:
                        logger.error(f"Failed to mark story as read: {e}")
                except Exception as e:
                    logger.error(f"Error processing story: {e}")
                    continue
    except Exception as e:
        logger.error(f"Error getting stories: {e}")

    # Получение архивных чатов: с непрочитанными ИЛИ форумы (unread может не учитываться на уровне диалога)
    archived_dialogs = []
    async for dialog in client.iter_dialogs(archived=True):
        if not dialog.archived:
            continue
        is_forum = getattr(dialog.entity, 'forum', False)
        if dialog.unread_count > 0 or is_forum:
            archived_dialogs.append(dialog)

    logger.info(f"Found {len(archived_dialogs)} archived chats to process")
    processed_archive_dialogs = 0
    
    for dialog in archived_dialogs:
        logger.info(f'Processing chat: {dialog.title} (Unread: {dialog.unread_count})')
        is_forum = getattr(dialog.entity, 'forum', False)
        if is_forum:
            await process_forum_topics(dialog)
        else:
            await process_regular_chat(dialog)
        processed_archive_dialogs += 1

    write_archive_status(
        archiveProcessedDialogCount=processed_archive_dialogs,
        archiveFoundDialogCount=len(archived_dialogs),
    )

    logger.info("Finished processing all messages and stories")

if __name__ == '__main__':
    try:
        logger.info("Starting telegram reader with Python: %s", sys.executable)
        with telegram_session_lock():
            with client:
                client.loop.run_until_complete(main())
    except Exception:
        try:
            write_archive_status(archiveError="Fatal error while running telegram reader")
        except Exception:
            pass
        logger.exception(
            "Fatal error while running telegram reader. If Telegram asks for a new login code, "
            "run the script manually in a terminal to refresh the session."
        )
        raise SystemExit(1)
