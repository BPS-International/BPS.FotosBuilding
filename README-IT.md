# BPS.FotosBuilding — пакет для IT (Flask, без PowerShell)

Стек: HTML + CSS + JavaScript (браузер) и Python Flask (сервер).
Оригиналы фото **не входят** в архив — читаются из общей папки.

## Требования

- Python 3.9+ (https://www.python.org/downloads/) с галкой **Add python.exe to PATH**
- Доступ к общей папке фото с машины сервера, например:
  `C:\BPS\OneDrive - BPS International GmbH\101_UH9.UH9\04_DOC\00_KOR\Fotos building`
- Форматы фото: JPEG, PNG, **HEIC/HEIF** (iPhone). В браузере HEIC показывается как JPEG-копия; оригинал остаётся в общей папке.
- PDF планов этажей: папка `Level` внутри `Fotos building` текущего проекта, например  
  `...\101_UH9.UH9\04_DOC\00_KOR\Fotos building\Level`.  
  Привязка этажа к имени файла и расстановка фото не меняются: ищется тот же PDF по имени.

## Запуск на Windows

1. Распаковать ZIP в папку (например `C:\BPS\FotosBuilding\`).
2. Проверить путь в `data\photos-source.json` (`photosRoot`). При другом диске — поправить JSON или задать переменную `BPS_PHOTOS_ROOT`.
3. Дважды щёлкнуть **`start.bat`** (не PowerShell).
4. Открыть в браузере: `http://127.0.0.1:8080/`
5. LAN: `http://<IP-сервера>:8080/` (файрвол: входящий TCP 8080).

Окно `start.bat` не закрывать, пока сайт нужен.

## Запуск на Linux

```bash
chmod +x start.sh
./start.sh
```

## Обновление фото

Пользователь кладёт новые файлы в общую папку и нажимает зелёную кнопку обновления справа от шкалы дат. Сервер пересканирует папку и обновляет список дат.

## Проекты

Список в шапке показывает код объекта (`100_BPS.OSZ`). Соседние папки OneDrive с `04_DOC\00_KOR\Fotos building` подхватываются сами.

Новый проект добавляется **только в режиме редактирования** (`http://127.0.0.1:8080/` без `?mode=share`): кнопка **+** рядом со списком. Вставить полный путь к `Fotos building` или к папке объекта, например:

`C:\BPS\OneDrive - BPS International GmbH\100_BPS.OSZ\04_DOC\00_KOR\Fotos building`

После добавления сразу загружаются фото из этой папки. В `?mode=share` кнопка **+** скрыта, список только для переключения.

## Состав архива

| Путь | Назначение |
|------|------------|
| `index.html`, `app.js`, `styles.css` | интерфейс |
| `server.py`, `photos_index.py` | Flask |
| `requirements.txt` | Flask, Pillow |
| `start.bat` / `start.sh` | запуск |
| `data/` | photos.json, floors.json, seeds.json |
| `thumbs/`, `ai/`, `converted/`, `plan/` | превью, JPEG из HEIC и PDF |
| `originals/` | пусто: оригиналы из photosRoot |

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BPS_HOST` | `0.0.0.0` (через start.bat) | слушать все интерфейсы |
| `BPS_PORT` | `8080` | порт |
| `BPS_PHOTOS_ROOT` | из `data/photos-source.json` | папка оригиналов |
| `BPS_WRITE_TOKEN` | пусто | опциональная защита записи |

Публичный просмотр без кнопок правки: `http://host:8080/?mode=share` (кнопка обновления фото остаётся).

На Render задайте `BPS_PUBLIC_VIEW=1` и `PORT` (его выставляет хостинг). Start:
`gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 120 server:app`.
