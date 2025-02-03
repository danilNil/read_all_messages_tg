from telethon import TelegramClient, types, functions
from datetime import datetime
import asyncio
from telethon.tl.functions.stories import GetAllStoriesRequest, ReadStoriesRequest
import logging
import os

# Настройка логирования
log_filename = f'telegram_reader_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_filename, encoding='utf-8'),
        logging.StreamHandler()  # This will also print to console
    ]
)
logger = logging.getLogger(__name__)

# Введите ваши учетные данные
api_id = '27548810'
api_hash = '7a3b0463bc09ba8c69a9ef369c2ad9bd'
phone_number = '+79514141228'

# Создание клиента
client = TelegramClient('session_name', api_id, api_hash)

async def main():
    # Вход в аккаунт
    await client.start(phone_number)
    logger.info("Successfully logged into Telegram")

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