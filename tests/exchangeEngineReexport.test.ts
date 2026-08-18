import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as exchangeEngine from '@solncebro/exchange-engine';

import * as exchangeEntry from '../src/exchange';
import * as mainEntry from '../src/index';

/**
 * Сторож единой двери: всё, что отдаёт нижняя библиотека, обязано выходить и отсюда.
 *
 * Правило потребителей — «есть trade-engine, значит exchange-engine напрямую не трогаем». Пока
 * поверхность собиралась поимённым перечнем, правило регулярно упиралось в забытое имя, и лечилось
 * это новой публикацией пакета: восемь выпусков за пять месяцев, включая патч 3.3.1 в тот же день,
 * что и 3.3.0, и `TriggerByEnum`, который пришлось реэкспортировать дважды — второй раз уже после
 * боевого инцидента с реальными деньгами. Тест закрывает возврат к перечню.
 */

/** Класс-фабрика биржи наружу не отдаётся СОЗНАТЕЛЬНО: единственная дверь к бирже — ExchangeConnector.
 *  Как ТИП он доступен (его приносит `export type *`), создать его в обход двери нельзя. */
const VALUE_EXPORT_ALLOWED_TO_STAY_INSIDE = new Set(['Exchange']);

function valueExportNameList(moduleObject: object): string[] {
  return Object.keys(moduleObject).sort();
}

describe('exchange-engine re-export surface', () => {
  it.each([
    ['main entry', mainEntry],
    ['exchange entry', exchangeEntry],
  ])('%s re-exports every value of the exchange layer', (_label, entry) => {
    const missingList = valueExportNameList(exchangeEngine)
      .filter((name) => !VALUE_EXPORT_ALLOWED_TO_STAY_INSIDE.has(name))
      .filter((name) => !(name in entry));

    expect(missingList).toEqual([]);
  });

  // Типы при сборке исчезают, поэтому перечислить их в рантайме нельзя — сторожим сам механизм.
  // Пока стоит сквозная строка, потерять тип невозможно; вернётся поимённый перечень — упадёт тут.
  it.each([
    ['types entry', 'src/types/index.ts'],
    ['main entry', 'src/index.ts'],
    ['exchange entry', 'src/exchange.ts'],
  ])('%s keeps types flowing through, not listed by hand', (_label, relativePath) => {
    const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');
    const hasPassThrough = source.includes("export type * from '@solncebro/exchange-engine'");
    const hasOwnPassThrough = source.includes("export * from './types'");

    expect(hasPassThrough || hasOwnPassThrough).toBe(true);
  });

  it('does not hand-list exchange-layer types anywhere', () => {
    for (const relativePath of ['src/types/index.ts', 'src/index.ts', 'src/exchange.ts']) {
      const source = readFileSync(join(__dirname, '..', relativePath), 'utf8');

      // `export type { … } from '@solncebro/exchange-engine'` — это и есть тот самый перечень.
      expect(source).not.toMatch(/export type \{[^}]*\}\s*from\s*'@solncebro\/exchange-engine'/s);
    }
  });
});
