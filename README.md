# BPS.FotosBuilding — Flask web application

Веб-интерфейс просмотра строительных фотографий и разметки камер на PDF-плане.
Backend полностью работает на Python/Flask; PHP не требуется.

## Стек

- Python 3.9+ и Flask
- HTML/CSS/Vanilla JavaScript
- PDF.js для отображения планов
- JSON для данных и разметки
- Nginx или Python-handler хостинг-панели

## Локальный запуск

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

Сайт: `http://127.0.0.1:8080/`

Windows PowerShell:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python server.py
```

## Развёртывание

В ISPmanager выберите обработчик Python и режим Python web server, загрузите проект,
установите пакеты из `requirements.txt` и перезапустите Python-приложение. Каталог
`data/` должен быть доступен на запись пользователю сайта.

Переменные окружения:

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `BPS_HOST` | `127.0.0.1` | Адрес встроенного dev-сервера |
| `BPS_PORT` | `8080` | Порт dev-сервера |
| `BPS_WRITE_TOKEN` | пусто | Защита изменения разметки и источника |
| `BPS_SOURCE_HOSTS` | все публичные домены | Разрешённые домены manifest через запятую |
| `BPS_SOURCE_TIMEOUT` | `12` | Таймаут загрузки manifest в секундах |

Для публичного сайта обязательно задайте `BPS_WRITE_TOKEN`. В браузере редактора:

```js
localStorage.setItem('bps.fotosbuilding.writeToken', 'change-me')
```

## Источники фотографий

По умолчанию используется локальный `data/photos.json` и каталоги `thumbs/`, `ai/`,
`originals/`. Кнопка «Источник фотографий» позволяет указать прямую HTTP(S)-ссылку
на удалённый JSON-manifest.

Минимальный формат:

```json
{
  "dates": ["2026-08-11"],
  "photos": [
    {
      "id": "photo-1-2026-08-11",
      "number": 1,
      "date": "2026-08-11",
      "file": "photo-1.jpg",
      "thumb": "thumbs/photo-1.jpg",
      "ai": "preview/photo-1.jpg",
      "originalUrl": "originals/photo-1.jpg"
    }
  ]
}
```

Относительные адреса изображений вычисляются относительно URL manifest. Можно также
использовать полные `https://`-адреса.

При сохранении нового источника Flask сначала загружает и проверяет manifest. Только
после успешной проверки он сохраняется в `data/remote-photos.json` и становится активным.
Если кеш удалён или повреждён, приложение автоматически возвращается к локальному
`data/photos.json`.

Обычная ссылка на страницу папки OneDrive/Google Drive не является manifest. Для неё
потребуется отдельная интеграция с API соответствующего облака либо публикация
`photos.json` рядом с изображениями.

Для ограничения источников задайте, например:

```bash
BPS_SOURCE_HOSTS='cdn.example.com,storage.example.com'
```

Flask блокирует localhost, приватные IP-адреса, URL со встроенным паролем и manifest
больше 5 МБ.

## Render (публичный сайт)

Каталог `UH9WEB` выкладывается как Python Web Service **BPS.FotosBuilding**
(репозиторий `https://github.com/BPS-International/BPS.FotosBuilding`).
Публичный URL: `https://bps-fotosbuilding.onrender.com`.

1. Подключите этот каталог как Git-репозиторий сервиса (Blueprint `render.yaml` или
   Root Directory = корень `UH9WEB`).
2. Start Command: `gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 8 --timeout 120 server:app`
3. Health Check Path: `/health`
4. Env: `BPS_PUBLIC_VIEW=1` (просмотр без кнопок правки). `BPS_WRITE_TOKEN` задаётся
   автоматически в `render.yaml`.

На Render нет локального OneDrive: оригиналы, thumbs, AI-превью и PDF берутся из
пакетов `originals/`, `thumbs/`, `ai/`, `plan/` рядом с `server.py`.

## API

| Метод и путь | Назначение |
|---|---|
| `GET /api/health` | Проверка приложения |
| `GET /api/meta` | Метаданные приложения / build stamp |
| `GET /api/floors` | Этажи и PDF-планы |
| `POST /api/floor-rotation` | Поворот плана этажа |
| `POST /api/plan` | Загрузка/замена PDF плана |
| `GET/POST /api/seeds` | Чтение/сохранение разметки (+ `gpsCalib`) |
| `GET /api/photos` | Активный список фотографий |
| `GET/POST /api/source` | Текущий источник/смена источника |
| `POST /api/source/test` | Проверка URL без сохранения |
| `POST /api/source/refresh` | Обновление кеша активного источника |

По умолчанию открывается **edit**-режим (кнопки «Заменить план», GPS-калибровка, «Источник» и т.д.).
Для публичного просмотра без edit-кнопок: `?mode=share`.

## Обновление локального контента

Существующий `Publish-WebServer.ps1` может продолжать обновлять `photos.json` и медиа.
Не перезаписывайте серверный `data/seeds.json`, если на сайте уже появилась новая
разметка.

Для GPS-калибровки в `photos.json` у снимков должен быть блок `exif.hasGps=true`
с координатами. Если в `originals/` GPS-теги обнулены при выгрузке — замените файлы
оригиналами со смартфона.
