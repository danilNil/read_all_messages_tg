from telethon import TelegramClient
from datetime import datetime

# Введите ваши учетные данные
api_id = '27548810'
api_hash = '7a3b0463bc09ba8c69a9ef369c2ad9bd'
phone_number = '+79514141228'

# Создание клиента
client = TelegramClient('session_name', api_id, api_hash)

async def main():
    # Вход в аккаунт
    await client.start(phone_number)

    # Получение списка только архивных чатов с непрочитанными сообщениями
    archived_dialogs = []
    async for dialog in client.iter_dialogs(archived=True):
        if dialog.archived and dialog.unread_count > 0:
            archived_dialogs.append(dialog)

    print(f"\nНайдено архивных чатов с непрочитанными сообщениями: {len(archived_dialogs)}")
    
    for dialog in archived_dialogs:
        print(f'\nНазвание чата: {dialog.title}')
        print(f'Непрочитанных сообщений: {dialog.unread_count}')
        print('-' * 50)
        
        # Получаем только непрочитанные сообщения из чата
        async for message in client.iter_messages(dialog.id, limit=dialog.unread_count):
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

            # Выводим информацию о сообщении
            print(f'[{date}] {sender}: {message.text}')
            
            # Помечаем сообщение как прочитанное
            await message.mark_read()

with client:
    client.loop.run_until_complete(main())