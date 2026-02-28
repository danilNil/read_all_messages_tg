from telethon import TelegramClient, types, functions
from datetime import datetime
import asyncio
from telethon.tl.functions.stories import GetAllStoriesRequest, ReadStoriesRequest
import logging
import logging.handlers
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Single rotating log file (max 1MB, keep 2 backups = 3 files total)
script_dir = os.path.dirname(os.path.abspath(__file__))
log_filename = os.path.join(script_dir, 'telegram_reader.log')
file_handler = logging.handlers.RotatingFileHandler(
    log_filename, maxBytes=1024 * 1024, backupCount=2, encoding='utf-8'
)
file_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))
stream_handler = logging.StreamHandler()
stream_handler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

logging.basicConfig(level=logging.INFO, handlers=[file_handler, stream_handler])
logger = logging.getLogger(__name__)

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
client = TelegramClient('session_name', api_id, api_hash)


async def process_forum_topics(dialog):
    """Mark all unread messages in forum topics (Threads) as read."""
    entity = dialog.entity
    logger.info(f'Chat {dialog.title} is a forum (has topics). Processing topics...')
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
                    logger.info(f"Marked topic '{topic.title}' in chat {dialog.title} as read")
                    await asyncio.sleep(0.5)
                except Exception as e:
                    logger.error(f"Failed to mark topic '{topic.title}' in chat {dialog.title} as read: {e}")
        else:
            # GetForumTopics вернул 0 (монoфорум или др.) — помечаем весь канал как прочитанный
            logger.info(f'No topics from API for {dialog.title}, using ReadHistory fallback')
            try:
                last_msg = await client.get_messages(entity, limit=1)
                max_id = last_msg[0].id if last_msg else 0
                if max_id > 0:
                    await client(functions.channels.ReadHistoryRequest(
                        channel=entity,
                        max_id=max_id
                    ))
                    logger.info(f"Marked {dialog.title} as read (fallback)")
                else:
                    logger.warning(f"No messages in {dialog.title} to mark as read")
            except Exception as e:
                logger.error(f"ReadHistory fallback failed for {dialog.title}: {e}")
    except Exception as e:
        logger.error(f"Error processing forum topics in chat {dialog.title}: {e}")


async def process_regular_chat(dialog):
    """Mark unread messages in a regular chat as read (skip mentions)."""
    async for message in client.iter_messages(dialog.id, limit=dialog.unread_count):
        try:
            if getattr(message, 'mentioned', False):
                logger.info(f'Skipping message with mention from chat {dialog.title}')
                continue
            date = message.date.strftime("%Y-%m-%d %H:%M:%S")
            sender = "Unknown"
            if hasattr(message.sender, 'first_name'):
                sender = message.sender.first_name
                if message.sender.last_name:
                    sender += f" {message.sender.last_name}"
            elif hasattr(message.sender, 'title'):
                sender = message.sender.title
            logger.info(f'Reading message from {sender} at {date}: {(message.text or "")[:100]}...')
            await message.mark_read()
            logger.info(f'Marked message as read')
        except Exception as e:
            logger.error(f"Error processing message: {e}")


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
    
    for dialog in archived_dialogs:
        logger.info(f'Processing chat: {dialog.title} (Unread: {dialog.unread_count})')
        is_forum = getattr(dialog.entity, 'forum', False)
        if is_forum:
            await process_forum_topics(dialog)
        else:
            await process_regular_chat(dialog)

    logger.info("Finished processing all messages and stories")

with client:
    client.loop.run_until_complete(main())