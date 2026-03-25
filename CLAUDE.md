# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Команды

```bash
# Сборка (тесты → tsc)
yarn build

# Юнит-тесты
yarn test

# Проверка типов
npx tsc --noEmit

# Линтинг
yarn lint
yarn lint:fix

# Интеграционные тесты (нужны demo API-ключи в .env.test)
yarn test:integration              # все
yarn test:integration:binance      # Binance
yarn test:integration:bybit        # Bybit
yarn test:integration:e2e-signal   # E2E сигнал→ордер
yarn test:integration:mvp          # spot-fallback + limit-orders + multiple-symbols + error-handling

# Один юнит-тест
npx jest tests/utils.test.ts

# Один интеграционный тест
npx jest --config jest.integration.config.js --runInBand --testPathPatterns=<pattern>
```

**Jest 30** — флаг `--testPathPatterns` (множественное число), не `--testPathPattern`.

## Архитектура

**@solncebro/trade-engine** — библиотека торгового движка для Binance и Bybit с интеграцией Telegram и Firebase.

### Пайплайн: Сигнал → Ордер

1. Сигнал приходит (Telegram / WebSocket)
2. `OrderCalculator.resolveSymbolsForExchanges()` — маппинг символов с учётом префиксов (`1000FLOKI`)
3. `OrderCalculator.createOrderAttributesForSymbol()` — расчёт параметров ордера
4. Если нет данных на futures → `OrderCalculator.enrichWithSpotFallback()` — переключение на spot
5. `ExchangeConnector.createOrder()` — исполнение на бирже

### Подробная документация

| Файл | Содержание |
|------|-----------|
| [`.claude/rules/architecture.md`](.claude/rules/architecture.md) | Архитектура, слои, потоки данных, схема пайплайна |
| [`.claude/rules/exchange-connector.md`](.claude/rules/exchange-connector.md) | ExchangeConnector: подключение, тикеры, префиксы, demo trading |
| [`.claude/rules/order-calculator.md`](.claude/rules/order-calculator.md) | OrderCalculator: все методы расчёта ордеров |
| [`.claude/rules/types.md`](.claude/rules/types.md) | Система типов: OrderParams, OrderResult, маппинги, конфиги |
| [`.claude/rules/services.md`](.claude/rules/services.md) | Telegram, Firebase, Logger, утилиты |
| [`.claude/rules/testing.md`](.claude/rules/testing.md) | Тестирование: команды, паттерны, хелперы, символы |
| [`.claude/rules/code-conventions.md`](.claude/rules/code-conventions.md) | Конвенции: форматирование, импорты, именование, паттерны |

### Ключевые модули

- **`src/services/exchangeConnector.ts`** — обёртка над `@solncebro/exchange-engine`. Подключения, тикеры, резолвинг символов, исполнение ордеров. Прямой доступ к клиентам через `connector.spot` / `connector.futures`. → [подробнее](.claude/rules/exchange-connector.md)
- **`src/core/orderCalculator.ts`** — статические методы расчёта ордеров, маппинг символов, кредитное плечо, spot fallback. → [подробнее](.claude/rules/order-calculator.md)
- **`src/core/orderExecutor.ts`** — базовый класс исполнения ордеров с TP/SL и аварийным выходом.
- **`src/services/telegram*.ts`** — Telegram-бот (Telegraf) + MTProto-слушатель. → [подробнее](.claude/rules/services.md)
- **`src/services/firebaseServiceBase.ts`** — базовый класс Firestore CRUD с real-time подпиской. → [подробнее](.claude/rules/services.md)

### Ключевые принципы

- **Ошибки — не исключения**: `createOrder()` возвращает `errorText` в результате, не бросает. Проверка через `isOrderSuccessful(result)`. Прямые вызовы `connector.spot`/`connector.futures` могут бросать исключения — потребитель обрабатывает их сам.
- **Demo trading**: `ExchangeConfig.isDemoMode = true`, никаких ручных URL-переопределений.
- **Биржи**: `@solncebro/exchange-engine` (не CCXT напрямую). Bybit: WebSocket для ордеров.
- **Map-коллекции**: `SymbolMappingByExchange` и `ExchangeConnectorByName` — это `Map`, не объекты.

### Интеграционные тесты

- `.env.test` с `BINANCE_DEMO_API_KEY`, `BINANCE_DEMO_SECRET_KEY`, `BYBIT_DEMO_API_KEY`, `BYBIT_DEMO_SECRET_KEY`
- Тесты автоматически пропускаются при отсутствии ключей (`describeIfCredentials()`)
- Хелперы: `tests/integration/helpers/` — конфиги, символы, WS-эмулятор
- Всегда `--runInBand` (последовательно), таймаут 180 сек
- Интеграционные команды запускаются через `scripts/runIntegrationJest.js`, который очищает proxy-переменные окружения (`HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/GIT_HTTP_PROXY/GIT_HTTPS_PROXY/SOCKS_PROXY/SOCKS5_PROXY` и lowercase-варианты)
- → [подробнее](.claude/rules/testing.md)
