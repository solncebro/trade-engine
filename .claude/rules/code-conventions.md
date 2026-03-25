# Конвенции кода

## TypeScript

- Target: ES2022, module: CommonJS, strict mode
- Declarations (`*.d.ts`) генерируются при сборке
- Source maps включены

## Форматирование (Prettier)

- Single quotes, 2 пробела, trailing comma ES5
- Без скобок для одиночных аргументов стрелочных функций
- LF переводы строк, 80 символов ширина

## Импорты (ESLint)

Порядок групп с пустыми строками между ними:
1. `builtin` (node:path, node:crypto)
2. `external` (ws, dotenv, telegraf)
3. `internal` (../../src/...)
4. `sibling` (./helpers/...)
5. `parent` (../)
6. `index`

Алфавитная сортировка внутри групп (case-insensitive).

## Именование

- Переменные и параметры: `camelCase`
- Классы: `PascalCase`
- Enums и их значения: `PascalCase` (ключи), строковые значения (значения)
- Типы и интерфейсы: `PascalCase`
- Файлы: `camelCase.ts`, утилиты: `camelCase.utils.ts`
- Тесты: `camelCase.test.ts`
- Хелперы тестов: `camelCase.helper.ts` или `camelCase.helpers.ts`
- Константы: `SCREAMING_SNAKE_CASE` для строковых, `camelCase` для объектных

## Паттерны

### Ошибки — не исключения

Торговые операции возвращают структурированный результат вместо throw:
```typescript
// Правильно
const result = await connector.createOrder(params);
if (isOrderSuccessful(result)) { ... }
else { logger.warn(result.errorText); }

// Неправильно
try { await connector.createOrder(params); }
catch (error) { ... }
```

### Статические классы

`OrderCalculator` и `ConfigManager` — все методы `static`. Нет инстанцирования.

### Map-based коллекции

Маппинги бирж и символов — `Map`, не объекты:
```typescript
const connectorByName: ExchangeConnectorByName = new Map([[ExchangeNameEnum.Binance, connector]]);
const mapping: SymbolMappingByExchange = new Map([[exchangeName, new Map([['BTCUSDT', 'BTCUSDT']])]]);
```

### Event-driven сервисы

`TelegramMessageListener` и `FirebaseServiceBase` наследуют `EventEmitter`.

### Lazy initialization

Logger использует Proxy для ленивой инициализации — создаётся при первом обращении.

## Сборка

```bash
yarn build
# = rm -rf dist && yarn lint && yarn test --passWithNoTests && tsc -p tsconfig.json
```

Порядок: удаление dist → ESLint → юнит-тесты → компиляция TypeScript.
