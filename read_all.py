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

    # Получение списка только архивных чатов с непрочитанными сообщениями
    archived_dialogs = []
    async for dialog in client.iter_dialogs(archived=True):
        if dialog.archived and dialog.unread_count > 0:
            archived_dialogs.append(dialog)

    logger.info(f"Found {len(archived_dialogs)} archived chats with unread messages")
    
    for dialog in archived_dialogs:
        logger.info(f'Processing chat: {dialog.title} (Unread: {dialog.unread_count})')
        
        # Получаем только непрочитанные сообщения из чата
        async for message in client.iter_messages(dialog.id, limit=dialog.unread_count):
            try:
                # Проверяем, есть ли упоминание пользователя в сообщении
                mentioned = False
                if hasattr(message, 'mentioned'):
                    mentioned = message.mentioned
                
                # Пропускаем сообщения с упоминанием пользователя
                if mentioned:
                    logger.info(f'Skipping message with mention from chat {dialog.title}')
                    continue
                
                # Форматируем дату сообщения
                date = message.date.strftime("%Y-%m-%d %H:%M:%S")
                
                # Получаем имя отправителя с учетом типа отправителя
                if hasattr(message.sender, 'first_name'):  # Для пользователей
                    sender = message.sender.first_name
                    if message.sender.last_name:
                        sender += f" {message.sender.last_name}"
                elif hasattr(message.sender, 'title'):  # Для каналов
                    sender = message.sender.title
                else:
                    sender = "Unknown"

                # Логируем информацию о сообщении
                logger.info(f'Reading message from {sender} at {date}: {message.text[:100]}...')
                
                # Помечаем сообщение как прочитанное
                await message.mark_read()
                logger.info(f'Marked message as read')
            except Exception as e:
                logger.error(f"Error processing message: {e}")

    logger.info("Finished processing all messages and stories")

with client:
    client.loop.run_until_complete(main())