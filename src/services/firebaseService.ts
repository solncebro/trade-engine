import { EventEmitter } from 'events';

import admin from 'firebase-admin';

import { logger } from '../core/logger';
import {
  FirebaseStrategySettingsValues,
  FormatSettingMessageArgs,
  SettingChange,
} from '../types/firebase';
import { SettingConfigBase } from '../types/telegramCommandHandler';

export interface FirebaseServiceArgs<T> {
  documentPath: string;
  defaultData: T;
  onNotify: (message: string) => void | Promise<void>;
  onError: (message: string, error: unknown) => void | Promise<void>;
}

export class FirebaseService<T> extends EventEmitter {
  private firestore: admin.firestore.Firestore;
  private documentReference: admin.firestore.DocumentReference;
  private settingsListener: (() => void) | null = null;
  private currentData: T;
  private defaultData: T;
  protected onNotify: (message: string) => void | Promise<void>;
  protected onError: (message: string, error: unknown) => void | Promise<void>;

  constructor(args: FirebaseServiceArgs<T>) {
    super();

    const { documentPath, defaultData, onNotify, onError } = args;

    this.defaultData = defaultData;
    this.currentData = { ...defaultData };
    this.onNotify = onNotify;
    this.onError = onError;

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }

    this.firestore = admin.firestore();
    this.documentReference = this.firestore.doc(documentPath);
  }

  public async initialize(): Promise<void> {
    try {
      const document = await this.documentReference.get();

      if (document.exists) {
        const data = document.data() as T;
        this.updateCurrentData(data);
      } else {
        await this.notify('No data found in Firebase, using defaults');
      }

      this.subscribeToDataChanges();
    } catch (error) {
      await this.notifyError('Failed to initialize Firebase service', error);

      throw error;
    }
  }

  private subscribeToDataChanges(): void {
    this.settingsListener = this.documentReference.onSnapshot(document => {
      if (document.exists) {
        const data = document.data() as T;
        const previousData = { ...this.currentData };
        this.updateCurrentData(data);

        logger.info(
          {
            previous: previousData,
            current: this.currentData,
          },
          'Data updated from Firebase'
        );

        this.emit('dataChanged', {
          current: this.currentData,
          previous: previousData,
        });
      }
    });
  }

  private updateCurrentData(data: Partial<T>): void {
    this.currentData = { ...this.defaultData, ...data };
  }

  public getData(): T {
    return this.currentData;
  }

  public async updateData(data: Partial<T>): Promise<void> {
    try {
      await this.documentReference.update(data);

      logger.info({ data }, 'Updated data in Firebase');
    } catch (error) {
      logger.error({ error, data }, 'Failed to update data in Firebase');

      throw error;
    }
  }

  public getDocumentReference(): admin.firestore.DocumentReference {
    return this.documentReference;
  }

  public getFirestore(): admin.firestore.Firestore {
    return this.firestore;
  }

  private async notify(message: string): Promise<void> {
    await this.onNotify(message);
  }

  private async notifyError(message: string, error: unknown): Promise<void> {
    await this.onError(message, error);
  }

  public getChangedSettings(
    current: T,
    previous: T
  ): SettingChange<T[keyof T]>[] {
    const resultList: SettingChange<T[keyof T]>[] = [];

    for (const key in current) {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        continue;
      }

      const currentValue = current[key];
      const previousValue = previous[key];

      const isChanged =
        Array.isArray(currentValue) && Array.isArray(previousValue)
          ? JSON.stringify(currentValue) !== JSON.stringify(previousValue)
          : currentValue !== previousValue;

      resultList.push({
        key,
        current: currentValue,
        previous: previousValue,
        isChanged,
      });
    }

    return resultList;
  }

  protected getAddedAndRemovedItemsMessage<Item>(
    current: Item[],
    previous: Item[]
  ): string {
    const setCurrent = new Set(current);
    const setPrevious = new Set(previous);

    const currentDifference = current.filter(item => !setPrevious.has(item));
    const previousDifference = previous.filter(item => !setCurrent.has(item));

    const addedItems =
      currentDifference.length > 0
        ? `Added: ${currentDifference.join(', ')}`
        : '';
    const removedItems =
      previousDifference.length > 0
        ? `Removed: ${previousDifference.join(', ')}`
        : '';

    return `${addedItems}${addedItems && removedItems ? '; ' : ''}${removedItems}`;
  }

  private getConfigByKey<T extends SettingConfigBase>(
    key: string,
    configList: T[]
  ): T | null {
    const foundConfig = configList.find(configItem => configItem.key === key);

    return foundConfig ?? null;
  }

  protected formatSettingMessage<V extends FirebaseStrategySettingsValues>(
    args: FormatSettingMessageArgs<V>
  ): string {
    const { setting, booleanConfigList, numericConfigList, arrayConfigList } =
      args;
    const { key, current, previous, isChanged } = setting;

    if (typeof current === 'boolean' && typeof previous === 'boolean') {
      const config = this.getConfigByKey(key, booleanConfigList);

      let emoji: string;

      if (config) {
        emoji = current ? config.enabledEmoji : config.disabledEmoji;
      } else {
        emoji = current ? '✅' : '❌';
      }

      const label = config?.label ?? (key as string);
      const currentText = current ? 'YES' : 'NO';

      let previousText: string | null = null;

      if (isChanged) {
        previousText = previous ? 'YES' : 'NO';
      }

      const changeText = previousText ? ` (was: ${previousText})` : '';

      return `${label}: ${emoji} *${currentText}*${changeText}`;
    }

    if (typeof current === 'number' && typeof previous === 'number') {
      const config = this.getConfigByKey(key, numericConfigList);
      const suffix = config?.suffix ?? '';
      const label = config?.label ?? (key as string);
      const changeText = isChanged ? ` (was: ${previous}${suffix})` : '';

      return `${label}: *${current}${suffix}*${changeText}`;
    }

    if (Array.isArray(current) && Array.isArray(previous)) {
      const config = this.getConfigByKey(key, arrayConfigList);
      const label = config?.label ?? (key as string);
      const changeInfo = isChanged
        ? ` (${this.getAddedAndRemovedItemsMessage(current, previous)})`
        : '';

      return `${label}: ${current.length > 0 ? current.join(', ') : 'EMPTY'}${changeInfo}`;
    }

    return `\n${key}: ${current}${isChanged ? ` (was: ${previous})` : ''}`;
  }

  public async disconnect(): Promise<void> {
    try {
      if (this.settingsListener) {
        this.settingsListener();
        this.settingsListener = null;
      }

      await admin.app().delete();

      logger.info('Firebase service disconnected');
    } catch (error) {
      logger.error({ error }, 'Error disconnecting Firebase service');
    }
  }
}
