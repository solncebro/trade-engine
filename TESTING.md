# Инструкция по тестированию trade-engine

---

## 1. Подготовка учётных данных

### Binance Demo Trading

Demo Trading использует твой **реальный аккаунт Binance** — никаких отдельных регистраций не нужно. Один ключ работает для spot и futures одновременно.

1. **Перейди на:** https://demo.binance.com
   - Авторизуйся через свой основной аккаунт Binance

2. **Перейди в:** Profile → API Management

3. **Создай API ключ:**
   - Нажми "Create API"
   - Выбери тип: **HMAC-SHA256** (рекомендуется)
   - Укажи название ключа (например, `trade-engine-demo`)
   - Включи права: **Spot & Margin Trading**, **Futures**

4. **Сохрани:**
   - **API Key**
   - **Secret Key** (показывается только один раз!)

**API Endpoints:**

| | URL |
|---|---|
| Spot REST | `https://demo-api.binance.com` |
| Futures REST | `https://demo-fapi.binance.com` |
| Управление ключами | `https://demo.binance.com` |

---

### Bybit Demo Trading

Demo Trading использует твой **реальный аккаунт Bybit**.

1. **Перейди на:** https://demo.bybit.com
   - Авторизуйся через основной аккаунт Bybit

2. **Перейди в:** Profile → API Management

3. **Создай API ключ:**
   - Нажми "Create New Key"
   - Выбери "System-generated API Keys" (HMAC)
   - Включи права: **Spot**, **Derivatives** (Futures)

4. **Сохрани:**
   - **API Key**
   - **Secret Key**

5. **Тестовые средства:**
   - В demo аккаунте уже есть тестовые средства
   - Если нет — перейди в Assets → Request Test Funds

6. **Список разрешённых адресов:**
   - Ключ Bybit привязывается к списку IP. Адрес машины, с которой идут проверки, обязан быть в нём.
   - Если адреса нет — биржа отвечает `10010: Unmatched IP` на КАЖДЫЙ подписанный запрос
     (плечо, режим маржи, заявки, позиции), а публичные запросы при этом проходят.

**API Endpoints:**

| | URL |
|---|---|
| REST | `https://api-demo.bybit.com` |
| WebSocket | `wss://stream-demo.bybit.com/v5/trade` |
| Управление ключами | `https://demo.bybit.com` |

---

### OKX Demo Trading

Demo Trading использует твой **реальный аккаунт OKX**, переключённый в демо-режим.

1. **Перейди на:** https://www.okx.com → Demo trading

2. **Перейди в:** раздел API демо-аккаунта

3. **Создай API ключ:**
   - Придумай и запиши **кодовую фразу** (passphrase) — OKX просит её при создании ключа
     и подписывает ею каждый запрос. Посмотреть её потом нельзя.
   - Включи права на торговлю

4. **Сохрани ТРИ значения:** API Key, Secret Key и кодовую фразу

5. **Режим позиций:** проверки сами спрашивают у счёта, в каком он режиме — односторонний или
   «лонг и шорт» — и подстраиваются под ответ. Менять его руками не нужно.

**API Endpoints:**

| | URL |
|---|---|
| REST | `https://www.okx.com` (демо выбирается заголовком `x-simulated-trading: 1`, отдельного хоста нет) |
| WebSocket | `wss://wspap.okx.com:8443/ws/v5/{public,private,business}` |
| Управление ключами | `https://www.okx.com` → Demo trading |

---

## 2. Конфигурация окружения

### Создай файл `.env.test` в корне проекта:

```bash
# Binance Demo Trading
BINANCE_DEMO_API_KEY=your_binance_demo_api_key_here
BINANCE_DEMO_SECRET_KEY=your_binance_demo_secret_key_here

# Bybit Demo Trading
BYBIT_DEMO_API_KEY=your_bybit_demo_api_key_here
BYBIT_DEMO_SECRET_KEY=your_bybit_demo_secret_key_here

# OKX Demo Trading — три переменные, кодовая фраза обязательна
OKX_DEMO_API_KEY=your_okx_demo_api_key_here
OKX_DEMO_SECRET_KEY=your_okx_demo_secret_key_here
OKX_DEMO_PASSPHRASE=your_okx_demo_passphrase_here
```

Пример файла: `.env.test.example`

> **Внимание:** Не коммить credentials в git! Файл `.env*` уже в `.gitignore`.

---

## 3. Команды запуска

### Unit тесты (не требуют credentials)

```bash
yarn test
```

### Все интеграционные тесты

```bash
yarn test:integration
```

### По биржам

```bash
yarn test:integration:binance
yarn test:integration:bybit
yarn test:integration:okx
```

> Эти проверки **ставят заявки на демо-счёте** примерно на 100 USDT и закрывают их тут же,
> в том же тесте. Это штатное поведение, а не побочный эффект.

---

## 4. Интерпретация результатов

### Успешный запуск

```
PASS  tests/integration/okx.test.ts

Test Suites: 1 passed, 1 total
Tests:       17 passed, 17 total
```

### Тесты пропущены (нет credentials)

```
SKIP  tests/integration/okx.test.ts
  ... all tests skipped (no okx demo credentials)
```

Создай `.env.test` с demo credentials. Для OKX нужны **все три** переменные —
без `OKX_DEMO_PASSPHRASE` проверки считают ключ неполным и пропускают себя.

### Ошибка подключения

Проверь:

- API ключ и Secret введены верно
- Ключи скопированы полностью (без пробелов)
- Используются ключи от **demo.binance.com**, **demo.bybit.com** или демо-режима **okx.com** (не production!)
- Для OKX задана кодовая фраза и совпадает с той, что вводилась при создании ключа
- Для Bybit адрес машины добавлен в список разрешённых у ключа (иначе `10010: Unmatched IP`)
- Интернет подключение работает

---

## 5. Структура тестов

```
tests/
├── utils.test.ts                      # Unit: утилиты (normalizeSymbol, etc.)
├── positionManager.test.ts            # Unit: PositionManager по биржам и режимам позиций
├── orderBookTracker.test.ts           # Unit: живая книга и глубина потока по биржам
└── integration/                       # Живые проверки на демо-счетах
    ├── binance.test.ts                # Binance: ExchangeConnector + PositionManager (16 проверок)
    ├── bybit.test.ts                  # Bybit: ExchangeConnector + PositionManager (16 проверок)
    ├── okx.test.ts                    # OKX: ExchangeConnector + PositionManager (17 проверок)
    └── helpers/
        └── testnet.helpers.ts         # Конфиги демо-счетов, символы, сборка коннектора
```

Проверок вокруг `OrderCalculator` (`spot-fallback`, `limit-orders`, `multiple-symbols`,
`error-handling`, `e2e-signal`) больше нет: сам класс уехал из библиотеки в область листингов
(релиз 3.13.0), и проверять в trade-engine стало нечего.

### Что проверяется здесь, а что в exchange-engine

Здесь — только **обёртка**: разрешение имени символа с приставками, кэш тикеров, поведение
коннектора, потоки `PositionManager` (чтение позиций, плечо, режим маржи, открытие и закрытие
рыночной заявкой) и `OrderExecutor`.

**Договор с биржей** — единицы объёма, знаки величин, инварианты ответов, потоки котировок и
заявок — проверяется живыми пробами соседней библиотеки: `../exchange-engine/scripts/`
(инструкция — `README.md` там же; проба OKX — `okx-live-probe`, общая проверка договора —
`exchange-live-check`).

Дублировать эти проверки здесь запрещено: две копии одной правды расходятся, и по расхождению
уже не понять, где ошибка — в обёртке или в договоре с биржей.

---

## 6. Полный цикл тестирования

```bash
yarn test                      # Unit тесты
yarn lint                      # Линтер
yarn test:integration          # Все живые проверки (ставят и закрывают заявки на демо)
```
