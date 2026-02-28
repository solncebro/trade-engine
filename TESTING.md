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

**API Endpoints:**

| | URL |
|---|---|
| REST | `https://api-demo.bybit.com` |
| WebSocket | `wss://stream-demo.bybit.com/v5/trade` |
| Управление ключами | `https://demo.bybit.com` |

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
```

Пример файла: `.env.test.example`

> **Внимание:** Не коммить credentials в git! Файл `.env*` уже в `.gitignore`.

---

## 3. Команды запуска

### Unit тесты (не требуют credentials)

```bash
yarn test
```

### MVP интеграционные тесты (рекомендуется начать отсюда)

```bash
yarn test:integration:mvp
```

Покрывает:

- Spot Fallback (переключение на spot при недоступности фьючерсов)
- Multiple Symbols (одновременная торговля BTC, ETH, XRP)
- Limit Orders (лимит-ордеры с коррекцией цены +40%)
- Error Scenarios (graceful обработка ошибок API)

### Все интеграционные тесты

```bash
yarn test:integration
```

### Отдельные сценарии

```bash
yarn test:integration:spot-fallback
yarn test:integration:multiple-symbols
yarn test:integration:limit-orders
yarn test:integration:error-handling
```

### По биржам

```bash
yarn test:integration:binance
yarn test:integration:bybit
```

---

## 4. Интерпретация результатов

### Успешный запуск

```
PASS  tests/integration/spot-fallback.test.ts
PASS  tests/integration/limit-orders.test.ts
PASS  tests/integration/multiple-symbols.test.ts
PASS  tests/integration/error-handling.test.ts

Test Suites: 4 passed, 4 total
Tests:       45 passed, 45 total
```

### Тесты пропущены (нет credentials)

```
SKIP  tests/integration/spot-fallback.test.ts
  ... all tests skipped (no bybit demo credentials)
```

Создай `.env.test` с demo credentials.

### Ошибка подключения

Проверь:

- API ключ и Secret введены верно
- Ключи скопированы полностью (без пробелов)
- Используются ключи от **demo.binance.com** или **demo.bybit.com** (не production!)
- Интернет подключение работает

---

## 5. Структура тестов

```
tests/
├── utils.test.ts                      # Unit: утилиты (normalizeSymbol, etc.)
├── bybitNativeTradeWebSocket.test.ts  # Unit: Bybit WebSocket
└── integration/                       # Интеграционные тесты
    ├── spot-fallback.test.ts          # MVP: Fallback на spot market
    ├── limit-orders.test.ts           # MVP: Лимит-ордеры с +40% коррекцией
    ├── multiple-symbols.test.ts       # MVP: Торговля несколькими парами
    ├── error-handling.test.ts         # MVP: Graceful error handling
    ├── binance.test.ts                # Binance: ExchangeConnector + OrderCalculator (18 тестов)
    ├── bybit.test.ts                  # Bybit: ExchangeConnector + OrderCalculator (18 тестов)
    └── helpers/
        └── testnet.helpers.ts         # Общие утилиты и конфигурация
```

---

## 6. Полный цикл тестирования

```bash
yarn test                      # Unit тесты
yarn test:integration:mvp      # MVP интеграционные
yarn test:integration          # Все интеграционные
```
